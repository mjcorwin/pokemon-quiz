// On-device "who said that?" for two-player mode.
//
// A small neural speaker-embedding model (WeSpeaker CAM++, trained on
// VoxCeleb) turns a stretch of speech into 512 numbers that describe the
// voice rather than the words. During the voice check we store one of these
// "voiceprints" per player; a correct guess goes to whichever voiceprint the
// guess sounds closest to.
//
// Everything runs in this browser tab with ONNX Runtime Web (WebAssembly).
// The model and runtime are served from this folder, audio never leaves the
// machine, and voiceprints are kept in memory only.
//
// The pure parts (feature extraction, resampling, voice activity, scoring)
// also load in Node for testing: require('./voiceid.js').
(function (root) {
  const RATE = 16000; // the model's sample rate
  const BLOCK = 160; // 10 ms of audio: the unit for voice-activity decisions
  const MODEL_URL = 'models/speaker-campplus-fp16.onnx';
  const ORT_DIR = 'vendor/onnxruntime-web/';

  // ---------- Kaldi-compatible 80-band log-mel filterbank ----------
  // Matches kaldi-native-fbank with dither 0 and snip_edges false, which is
  // how the model's features were computed in training, followed by
  // per-utterance mean normalization.

  const FRAME_LEN = 400; // 25 ms
  const FRAME_SHIFT = 160; // 10 ms
  const NFFT = 512;
  const NMEL = 80;

  let fbankTables = null;
  function tables() {
    if (fbankTables) return fbankTables;
    const win = new Float64Array(FRAME_LEN);
    for (let i = 0; i < FRAME_LEN; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)), 0.85); // "povey"
    const mel = (f) => 1127 * Math.log(1 + f / 700);
    const lo = mel(20), hi = mel(RATE / 2);
    const delta = (hi - lo) / (NMEL + 1);
    const bins = [];
    for (let m = 0; m < NMEL; m++) {
      const left = lo + m * delta, center = left + delta, right = center + delta;
      const taps = [];
      for (let k = 0; k < NFFT / 2; k++) {
        const x = mel((k * RATE) / NFFT);
        if (x > left && x < right) taps.push([k, x <= center ? (x - left) / (center - left) : (right - x) / (right - center)]);
      }
      bins.push(taps);
    }
    const cos = new Float64Array(NFFT / 2), sin = new Float64Array(NFFT / 2);
    for (let i = 0; i < NFFT / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / NFFT); sin[i] = Math.sin((-2 * Math.PI * i) / NFFT); }
    const rev = new Uint16Array(NFFT);
    for (let i = 0, bits = Math.log2(NFFT); i < NFFT; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    return (fbankTables = { win, bins, cos, sin, rev });
  }

  function fft(re, im, t) {
    for (let i = 0; i < NFFT; i++) {
      const j = t.rev[i];
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= NFFT; len <<= 1) {
      const half = len >> 1, step = NFFT / len;
      for (let i = 0; i < NFFT; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = t.cos[k * step], wi = t.sin[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // samples: Float32Array at 16 kHz in [-1, 1]. Returns { data, frames } with
  // data laid out [frames][80], ready for the model.
  function fbank(samples) {
    const t = tables();
    const n = samples.length;
    const frames = Math.floor((n + FRAME_SHIFT / 2) / FRAME_SHIFT);
    const data = new Float32Array(frames * NMEL);
    const w = new Float64Array(FRAME_LEN);
    const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    for (let f = 0; f < frames; f++) {
      const start = f * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LEN / 2;
      let mean = 0;
      for (let j = 0; j < FRAME_LEN; j++) {
        let s = start + j;
        while (s < 0 || s >= n) s = s < 0 ? -s - 1 : 2 * n - 1 - s; // reflect at the edges
        w[j] = samples[s] * 32768;
        mean += w[j];
      }
      mean /= FRAME_LEN;
      for (let j = 0; j < FRAME_LEN; j++) w[j] -= mean;
      for (let j = FRAME_LEN - 1; j > 0; j--) w[j] -= 0.97 * w[j - 1];
      w[0] -= 0.97 * w[0];
      re.fill(0); im.fill(0);
      for (let j = 0; j < FRAME_LEN; j++) re[j] = w[j] * t.win[j];
      fft(re, im, t);
      for (let m = 0; m < NMEL; m++) {
        let e = 0;
        for (const [k, g] of t.bins[m]) e += g * (re[k] * re[k] + im[k] * im[k]);
        data[f * NMEL + m] = Math.log(Math.max(e, 1.1920929e-7));
      }
    }
    // Per-utterance mean normalization, as in training.
    for (let m = 0; m < NMEL; m++) {
      let s = 0;
      for (let f = 0; f < frames; f++) s += data[f * NMEL + m];
      s /= frames || 1;
      for (let f = 0; f < frames; f++) data[f * NMEL + m] -= s;
    }
    return { data, frames };
  }

  // ---------- streaming resampler (mic rate -> 16 kHz) ----------
  class Resampler {
    constructor(inRate) {
      this.ratio = inRate / RATE;
      // Windowed-sinc low-pass just under 8 kHz so nothing aliases.
      const taps = 48;
      const fc = (0.95 * (RATE / 2)) / inRate;
      this.h = new Float32Array(taps + 1);
      let sum = 0;
      for (let i = 0; i <= taps; i++) {
        const x = i - taps / 2;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        this.h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / taps) + 0.08 * Math.cos((4 * Math.PI * i) / taps));
        sum += this.h[i];
      }
      for (let i = 0; i <= taps; i++) this.h[i] /= sum;
      this.hist = new Float32Array(taps); // last inputs, for filter continuity
      this.pos = 0; // next output position, in input samples relative to this chunk
    }
    process(input) {
      if (this.ratio === 1) return Float32Array.from(input);
      const H = this.h, L = H.length, hist = this.hist;
      // Low-pass the chunk (with history), then pick samples by linear interpolation.
      const x = new Float32Array(hist.length + input.length);
      x.set(hist); x.set(input, hist.length);
      const y = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        let s = 0;
        const base = i + hist.length - (L - 1);
        for (let k = 0; k < L; k++) { const idx = base + k; if (idx >= 0) s += H[k] * x[idx]; }
        y[i] = s;
      }
      this.hist = x.subarray(x.length - hist.length).slice();
      const out = [];
      let p = this.pos;
      const last = this.prev === undefined ? y[0] : this.prev;
      for (; p < input.length - 1 + 1e-9; p += this.ratio) {
        const j = Math.floor(p), f = p - j;
        const a = j < 0 ? last : y[j];
        const b = j + 1 < y.length ? y[j + 1] : y[j];
        out.push(a + (b - a) * f);
      }
      this.pos = p - input.length;
      this.prev = y[y.length - 1];
      return Float32Array.from(out);
    }
  }

  // ---------- voice activity ----------
  // A 10 ms block counts as speech when it's clearly louder than the room.
  // The room level is the quietest block of the last ~2 s, so it adapts to
  // background noise, and a short hangover keeps soft word endings.
  class Vad {
    constructor() { this.hist = []; this.hang = 0; }
    push(block) {
      let e = 0;
      for (let i = 0; i < block.length; i++) e += block[i] * block[i];
      const rms = Math.sqrt(e / block.length);
      this.hist.push(rms);
      if (this.hist.length > 200) this.hist.shift();
      let noise = Infinity;
      for (const v of this.hist) if (v < noise) noise = v;
      const loud = this.hist.length >= 10 && rms > Math.max(0.002, noise * 3);
      if (loud) this.hang = 20;
      else if (this.hang > 0) this.hang--;
      return { rms, speech: loud || this.hang > 0 };
    }
  }

  // ---------- the neural model ----------
  const model = { session: null, loading: null };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }

  // Safe to call early (e.g. when "2 players" is picked) to warm up.
  function loadModel() {
    if (!model.loading) {
      model.loading = (async () => {
        if (!root.ort) await loadScript(ORT_DIR + 'ort.wasm.min.js');
        const ort = root.ort;
        ort.env.wasm.wasmPaths = new URL(ORT_DIR, root.location.href).href;
        ort.env.wasm.numThreads = 1; // threads need special server headers; one is plenty here
        ort.env.logLevel = 'error';
        model.session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
      })().catch((err) => { model.loading = null; throw err; });
    }
    return model.loading;
  }

  // 16 kHz speech -> unit-length voiceprint (Float32Array of 512).
  async function embed(samples) {
    await loadModel();
    const { data, frames } = fbank(samples);
    const ort = root.ort;
    const out = await model.session.run({ feats: new ort.Tensor('float32', data, [1, frames, NMEL]) });
    const v = Float32Array.from(out[model.session.outputNames[0]].data);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  // ---------- decisions ----------
  // Calibrated on recorded speech from many different voices: when the two
  // players score within UNSURE of each other the game asks instead of guessing,
  // and a voice check whose SIMILAR margin is small gets a "sound alike" warning.
  const UNSURE = 0.05;
  const SIMILAR = 0.15;
  const MIN_SPEECH_S = 0.3;

  // Build a player's profile from their voice-check audio.
  async function enroll(samples) {
    const half = samples.length >> 1;
    return {
      print: await embed(samples),
      halves: [await embed(samples.subarray(0, half)), await embed(samples.subarray(half))],
    };
  }

  // How clearly the two voices differ: how much each player's two halves agree
  // with each other, minus how much they agree with the other player.
  function distinctness(a, b) {
    const self = Math.min(dot(a.halves[0], a.halves[1]), dot(b.halves[0], b.halves[1]));
    let cross = 0;
    for (const x of a.halves) for (const y of b.halves) cross += dot(x, y) / 4;
    return self - cross;
  }
  const soundAlike = (a, b) => distinctness(a, b) < SIMILAR;

  // Returns { player, sure, scores } or null when there's too little speech.
  async function identify(profiles, samples) {
    if (!profiles || samples.length < MIN_SPEECH_S * RATE) return null;
    const v = await embed(samples);
    const scores = profiles.map((p) => dot(v, p.print));
    const player = scores[1] > scores[0] ? 1 : 0;
    return { player, sure: Math.abs(scores[1] - scores[0]) >= UNSURE, scores };
  }

  // ---------- live mic listener (browser only) ----------
  // An AudioWorklet hands us every raw mic sample; we resample to 16 kHz, mark
  // each 10 ms block as speech or not, and keep the last 12 s.
  class Listener {
    constructor() {
      this.blocks = []; // { t, speech, samples }
      this.onBlock = null; // ({ rms, speech, samples, t }) => void
      this.running = false;
    }

    // Call from a click handler: the AudioContext is created synchronously so
    // browsers treat it as user-initiated.
    start() {
      if (this.running) return Promise.resolve();
      if (this.starting) return this.starting;
      const AC = root.AudioContext || root.webkitAudioContext;
      this.ctx = this.ctx || new AC();
      if (this.ctx.resume) this.ctx.resume();
      this.starting = (async () => {
        if (!this.workletReady) {
          await this.ctx.audioWorklet.addModule('voice-worklet.js');
          this.workletReady = true;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
        this.stream = stream;
        this.src = this.ctx.createMediaStreamSource(stream);
        this.node = new AudioWorkletNode(this.ctx, 'mic-capture');
        this.mute = this.ctx.createGain();
        this.mute.gain.value = 0; // keeps the node running without playing the mic back
        this.src.connect(this.node).connect(this.mute).connect(this.ctx.destination);
        this.resampler = new Resampler(this.ctx.sampleRate);
        this.vad = new Vad();
        this.pending = new Float32Array(0);
        this.blocks = [];
        this.node.port.onmessage = (e) => this.onChunk(e.data);
        this.running = true;
      })().finally(() => { this.starting = null; });
      return this.starting;
    }

    onChunk(chunk) {
      const now = performance.now();
      const y = this.resampler.process(chunk);
      const all = new Float32Array(this.pending.length + y.length);
      all.set(this.pending); all.set(y, this.pending.length);
      let off = 0;
      const count = Math.floor(all.length / BLOCK);
      for (let b = 0; b < count; b++, off += BLOCK) {
        const samples = all.slice(off, off + BLOCK);
        const { rms, speech } = this.vad.push(samples);
        const t = now - ((all.length - off - BLOCK) / RATE) * 1000;
        const block = { t, speech, samples, rms };
        this.blocks.push(block);
        if (this.onBlock) this.onBlock(block);
      }
      while (this.blocks.length > 1200) this.blocks.shift();
      this.pending = all.slice(off);
    }

    // All speech heard since time t0 (performance.now() clock), glued together.
    speechSince(t0) {
      const picked = this.blocks.filter((b) => b.t >= t0 && b.speech);
      const out = new Float32Array(picked.length * BLOCK);
      picked.forEach((b, i) => out.set(b.samples, i * BLOCK));
      return out;
    }

    stop() {
      if (this.src) this.src.disconnect();
      if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.src = this.node = this.stream = null;
      this.blocks = [];
      this.running = false;
    }
  }

  const api = {
    RATE, BLOCK, fbank, Resampler, Vad, loadModel, embed, enroll, identify, soundAlike, distinctness, Listener,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceID = api;
})(typeof window !== 'undefined' ? window : globalThis);
