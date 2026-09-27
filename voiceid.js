// On-device "who said that?" for two-player mode.
//
// Nothing leaves the machine and nothing is downloaded. Every ~30 ms we look at
// the last 2048 mic samples and, if someone is talking, turn them into a small
// voice fingerprint: pitch plus 12 MFCC-style numbers describing vocal tone.
// Each player gets one Gaussian model from a few seconds of speech at the start,
// and a guess is credited to whichever model most of its frames vote for.
//
// Works in the browser (window.VoiceID) and in Node (module.exports) for testing.
(function (root) {
  const FRAME = 2048;
  const N_MEL = 24;
  const N_CEP = 12;
  const F_LO = 80, F_HI = 7000;
  const PITCH_LO = 70, PITCH_HI = 650;

  // ---------- signal helpers ----------

  const hannCache = new Map();
  function hann(n) {
    let w = hannCache.get(n);
    if (!w) {
      w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      hannCache.set(n, w);
    }
    return w;
  }

  // In-place radix-2 FFT; returns the power spectrum (n/2 + 1 bins).
  function powerSpectrum(x) {
    const n = x.length;
    const w = hann(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = x[i] * w[i];
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
    const p = new Float64Array(n / 2 + 1);
    for (let i = 0; i <= n / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    return p;
  }

  const bankCache = new Map();
  function melBank(n, sr) {
    const key = n + ':' + sr;
    let bank = bankCache.get(key);
    if (bank) return bank;
    const mel = (f) => 2595 * Math.log10(1 + f / 700);
    const hz = (m) => 700 * (10 ** (m / 2595) - 1);
    const lo = mel(F_LO), hi = mel(Math.min(F_HI, sr / 2 - 1));
    const edges = [];
    for (let i = 0; i < N_MEL + 2; i++) edges.push((hz(lo + ((hi - lo) * i) / (N_MEL + 1)) * n) / sr);
    bank = [];
    for (let m = 0; m < N_MEL; m++) {
      const [a, b, c] = [edges[m], edges[m + 1], edges[m + 2]];
      const taps = [];
      for (let k = Math.max(1, Math.floor(a)); k <= Math.ceil(c) && k <= n / 2; k++) {
        const g = k < b ? (k - a) / (b - a) : (c - k) / (c - b);
        if (g > 0) taps.push([k, g]);
      }
      bank.push(taps);
    }
    bankCache.set(key, bank);
    return bank;
  }

  // Normalized autocorrelation pitch tracker. Returns { f0, clarity } where
  // clarity near 1 means a clean, periodic (voiced) sound.
  function pitch(x, sr) {
    // Halve the rate for speed; pitch lives well below 12 kHz.
    const n = x.length >> 1;
    const s = sr / 2;
    const y = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { y[i] = (x[2 * i] + x[2 * i + 1]) / 2; mean += y[i]; }
    mean /= n;
    const sq = new Float64Array(n + 1); // prefix sums of y^2
    for (let i = 0; i < n; i++) { y[i] -= mean; sq[i + 1] = sq[i] + y[i] * y[i]; }

    const minLag = Math.max(2, Math.floor(s / PITCH_HI));
    const maxLag = Math.min(Math.ceil(s / PITCH_LO), Math.floor(n / 2));
    const nr = new Float64Array(maxLag + 2);
    let best = 0;
    for (let l = minLag - 1; l <= maxLag + 1; l++) {
      let r = 0;
      for (let i = 0; i + l < n; i++) r += y[i] * y[i + l];
      const e = Math.sqrt(sq[n - l] * (sq[n] - sq[l]));
      nr[l] = e > 0 ? r / e : 0;
      if (l >= minLag && l <= maxLag && nr[l] > best) best = nr[l];
    }
    if (best <= 0) return { f0: 0, clarity: 0 };
    // Periodic signals score ~equally at T, 2T, 3T...; take the first strong peak.
    let lag = 0;
    for (let l = minLag; l <= maxLag; l++) {
      if (nr[l] >= 0.9 * best && nr[l] >= nr[l - 1] && nr[l] >= nr[l + 1]) { lag = l; break; }
    }
    if (!lag) return { f0: 0, clarity: 0 };
    const a = nr[lag - 1], b = nr[lag], c = nr[lag + 1];
    const d = a - 2 * b + c;
    const shift = d < 0 ? (0.5 * (a - c)) / d : 0;
    return { f0: s / (lag + shift), clarity: b };
  }

  // One frame of mic audio -> { rms, voiced, vec }. `state` tracks the room's
  // noise floor between calls so quiet background hum never counts as a voice.
  function features(x, sr, state) {
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / x.length);

    // Noise floor = the quietest frame in the last ~2 s. Speech always has
    // little gaps, so this settles on the room level even if someone was
    // already talking when the mic opened.
    const hist = (state.hist = state.hist || []);
    hist.push(rms);
    if (hist.length > 66) hist.shift();
    let noise = Infinity;
    for (const v of hist) if (v < noise) noise = v;
    state.noise = noise;

    const loud = hist.length >= 5 && rms > Math.max(0.003, noise * 2.5);
    if (!loud) return { rms, voiced: false };
    const p = pitch(x, sr);
    if (p.clarity < 0.5 || p.f0 < PITCH_LO || p.f0 > PITCH_HI) return { rms, voiced: false };

    const power = powerSpectrum(x);
    const bank = melBank(x.length, sr);
    const logMel = bank.map((taps) => {
      let s = 0;
      for (const [k, g] of taps) s += power[k] * g;
      return Math.log(s + 1e-10);
    });
    const vec = [Math.log2(p.f0)];
    for (let c = 1; c <= N_CEP; c++) {
      let s = 0;
      for (let m = 0; m < N_MEL; m++) s += logMel[m] * Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
      vec.push(s / N_MEL);
    }
    return { rms, voiced: true, f0: p.f0, vec };
  }

  // ---------- models ----------

  function stats(vecs) {
    const d = vecs[0].length;
    const mean = new Array(d).fill(0);
    const v = new Array(d).fill(0);
    for (const x of vecs) for (let i = 0; i < d; i++) mean[i] += x[i] / vecs.length;
    for (const x of vecs) for (let i = 0; i < d; i++) v[i] += (x[i] - mean[i]) ** 2 / vecs.length;
    return { mean, var: v };
  }

  // sets[p] = voiced frame vectors recorded for player p.
  function train(sets) {
    const each = sets.map(stats);
    // Typical within-player spread of each feature. Flooring against this (not
    // the spread across both players) keeps a feature that cleanly splits the
    // players, like pitch for a parent and a child, at full strength, while
    // stopping one player's unusually steady feature from dominating.
    const within = each[0].var.map((_, i) => each.reduce((t, s) => t + s.var[i], 0) / each.length);
    return each.map((s) => {
      s.var = s.var.map((v, i) => Math.max(v, 0.5 * within[i], 1e-6));
      s.logDet = s.var.reduce((t, v) => t + Math.log(v), 0);
      return s;
    });
  }

  function logLik(m, x) {
    let t = m.logDet;
    for (let i = 0; i < x.length; i++) t += (x[i] - m.mean[i]) ** 2 / m.var[i];
    return -0.5 * t;
  }

  // Each frame votes for its most likely player; most votes wins, total
  // likelihood breaks ties. Returns null when there's too little speech to judge.
  function identify(models, vecs, minFrames = 4) {
    if (!models || vecs.length < minFrames) return null;
    const votes = new Array(models.length).fill(0);
    const sums = new Array(models.length).fill(0);
    for (const x of vecs) {
      let best = 0, bestLL = -Infinity;
      models.forEach((m, i) => {
        const ll = Math.max(logLik(m, x), -200); // cap outliers
        sums[i] += ll;
        if (ll > bestLL) { bestLL = ll; best = i; }
      });
      votes[best]++;
    }
    let player = 0;
    for (let i = 1; i < models.length; i++) {
      if (votes[i] > votes[player] || (votes[i] === votes[player] && sums[i] > sums[player])) player = i;
    }
    return { player, confidence: votes[player] / vecs.length, frames: vecs.length };
  }

  // How often a frame lands on the right player when the models never saw it:
  // train on one half of each recording, test on the other half, then swap.
  // (Testing on the training audio is far too optimistic, because neighbouring
  // frames of real speech are nearly identical.) Low numbers mean the two
  // voices sound alike to this simple model.
  function separability(sets) {
    let right = 0, total = 0;
    for (let fold = 0; fold < 2; fold++) {
      const halves = sets.map((vecs) => {
        const mid = vecs.length >> 1;
        return fold ? [vecs.slice(mid), vecs.slice(0, mid)] : [vecs.slice(0, mid), vecs.slice(mid)];
      });
      const models = train(halves.map(([fit]) => fit));
      halves.forEach(([, test], p) => {
        for (const x of test) {
          if (identify(models, [x], 1).player === p) right++;
          total++;
        }
      });
    }
    return total ? right / total : 0;
  }

  // ---------- live mic listener (browser only) ----------

  class Listener {
    constructor() {
      this.frames = []; // recent voiced frames: { t, vec }
      this.state = {};
      this.onFrame = null; // (features, t) => void, every frame
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
      this.starting = navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then((stream) => {
          this.stream = stream;
          this.src = this.ctx.createMediaStreamSource(stream);
          this.an = this.ctx.createAnalyser();
          this.an.fftSize = FRAME;
          this.src.connect(this.an);
          this.buf = new Float32Array(FRAME);
          this.state = {};
          this.timer = setInterval(() => this.tick(), 30);
          this.running = true;
        })
        .finally(() => { this.starting = null; });
      return this.starting;
    }

    tick() {
      this.an.getFloatTimeDomainData(this.buf);
      const f = features(this.buf, this.ctx.sampleRate, this.state);
      const t = performance.now();
      if (f.voiced) {
        this.frames.push({ t, vec: f.vec });
        while (this.frames.length && this.frames[0].t < t - 15000) this.frames.shift();
      }
      if (this.onFrame) this.onFrame(f, t);
    }

    voicedSince(t0) {
      return this.frames.filter((f) => f.t >= t0).map((f) => f.vec);
    }

    stop() {
      clearInterval(this.timer);
      if (this.src) this.src.disconnect();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.src = this.stream = null;
      this.frames = [];
      this.running = false;
    }
  }

  const api = { FRAME, features, pitch, train, identify, separability, Listener };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceID = api;
})(typeof window !== 'undefined' ? window : globalThis);
