(() => {
  const { POKEMON, judge, normalize } = window.PokeMatch;
  const VoiceID = window.VoiceID;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // Kid mode is very forgiving: a low bar, a little slack when another Pokémon
  // scores slightly higher, earlier acceptance of partial speech, and free hints.
  const RULES = {
    kid:     { threshold: 0.4,  margin: 0.12, interimMin: 0.7, autoHintAfter: 2 },
    lenient: { threshold: 0.5,  margin: 0,    interimMin: 0.8, autoHintAfter: 0 },
    normal:  { threshold: 0.62, margin: 0,    interimMin: 0.8, autoHintAfter: 0 },
    strict:  { threshold: 0.8,  margin: 0,    interimMin: 0.8, autoHintAfter: 0 },
  };
  const rules = () => RULES[settings.strictness] || RULES.normal;
  const REVEAL_MS = 1800;
  const REVEAL_MS_2P = 2600; // a bit longer so a wrongly credited point can be fixed
  const WHO_WAIT_MS = 6000; // how long to wait for "who got it?" when the voice is unclear
  const ENROLL_SECONDS = 4; // seconds of actual speech each player gives the voice check

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const settings = Object.assign(
    { mode: 'silhouette', rounds: '25', strictness: 'normal', players: '1', names: ['Player 1', 'Player 2'] },
    store.get('wtp.settings', {})
  );
  const saveSettings = () => store.set('wtp.settings', settings);
  const twoPlayer = () => settings.players === '2';

  const game = {
    deck: [], idx: 0, current: null, phase: 'idle',
    score: 0, streak: 0, bestStreak: store.get('wtp.bestStreak', 0),
    hintLevel: 0, hintsUsed: 0, missed: [], advanceTimer: 0, wrongTries: 0,
    players: 1, names: [], scores: [0, 0], lastAward: null, uttStart: 0,
  };

  // Voiceprints live only in this tab. They're never saved or sent anywhere.
  const voice = { listener: null, profiles: null, key: '' };
  const voicesKey = () => settings.names.join('\u0000');
  const voicesReady = () => !!voice.profiles && voice.key === voicesKey();

  const el = {
    stage: $('stage'), mon: $('mon'), reveal: $('reveal'), hint: $('hint'),
    micBtn: $('micBtn'), micStatus: $('micStatus'), heard: $('heard'),
    form: $('guessForm'), input: $('guessInput'), names: $('names'),
    roundStat: $('roundStat'), scoreStat: $('scoreStat'), streakStat: $('streakStat'),
    overlay: $('overlay'), setup: $('setup'), results: $('results'), enroll: $('enroll'),
    playerChips: [$('p1Chip'), $('p2Chip')],
  };

  const sprite = (id) => `sprites/${id}.png`;

  // ---------- setup screen ----------
  function syncPlayersUI() {
    $('playerNames').hidden = !twoPlayer();
    $('revoiceBtn').hidden = !(twoPlayer() && voicesReady());
    // Start fetching the voice model as soon as two players is picked, so it's
    // ready by the time the voice check needs it. One player never loads it.
    if (twoPlayer() && VoiceID) VoiceID.loadModel().catch(() => {});
  }

  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.setting;
    const sync = () => seg.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.value === settings[key])));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = b.dataset.value;
      saveSettings();
      sync();
      syncPlayersUI();
    });
    sync();
  }

  [$('p1NameInput'), $('p2NameInput')].forEach((input, i) => {
    input.value = settings.names[i];
    input.addEventListener('input', () => {
      settings.names[i] = input.value.trim().slice(0, 16) || `Player ${i + 1}`;
      saveSettings();
      syncPlayersUI();
    });
  });
  $('revoiceBtn').addEventListener('click', () => { voice.profiles = null; syncPlayersUI(); });
  syncPlayersUI();

  el.names.innerHTML = POKEMON.map((p) => `<option value="${p.name}">`).join('');

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function setupWarn(msg) {
    $('setupWarn').textContent = msg || '';
    $('setupWarn').hidden = !msg;
  }

  async function onStart() {
    if (twoPlayer()) {
      if (!VoiceID || !navigator.mediaDevices || !window.AudioWorkletNode) {
        setupWarn('Two-player mode needs microphone access, which this browser doesn’t offer.');
        return;
      }
      voice.listener = voice.listener || new VoiceID.Listener();
      const starting = voice.listener.start(); // synchronous part must run inside the click
      try {
        await starting;
      } catch {
        setupWarn('Two-player mode needs the microphone. Allow mic access in the address bar and try again.');
        return;
      }
      setupWarn('');
      if (!voicesReady() && !(await enrollPlayers())) {
        voice.listener.stop();
        return;
      }
    }
    startGame();
  }

  function startGame() {
    const n = Math.min(Number(settings.rounds), POKEMON.length);
    const players = twoPlayer() ? 2 : 1;
    Object.assign(game, {
      deck: shuffle(POKEMON.map((p) => p.id)).slice(0, n),
      idx: -1, score: 0, streak: 0, hintsUsed: 0, missed: [],
      players, names: settings.names.slice(), scores: [0, 0], lastAward: null,
    });
    document.body.classList.toggle('two-player', players === 2);
    el.playerChips.forEach((c, i) => { c.querySelector('small').textContent = game.names[i]; });
    el.overlay.hidden = true;
    nextRound();
    if (SR && !mic.wanted) startMic();
  }

  // ---------- two-player voice check ----------
  const enroll = { cancel: null };

  function enrollUI({ title, prompt, progress = 0, note = '', ready = false, busy = false }) {
    $('enrollTitle').textContent = title;
    $('enrollPrompt').innerHTML = prompt;
    $('enrollProgress').style.width = `${Math.round(progress * 100)}%`;
    $('enrollNote').textContent = note;
    $('enrollNote').hidden = !note;
    $('enrollGo').hidden = !ready;
    $('enrollRedo').hidden = busy;
  }

  // Lets the Start over / Back buttons interrupt any step of the voice check.
  function cancellable(promise) {
    return new Promise((resolve, reject) => {
      enroll.cancel = reject;
      promise.then(resolve, reject);
    });
  }

  // Resolves with ENROLL_SECONDS of the player's speech (16 kHz samples), or
  // rejects with 'redo' / 'back'. Listening only starts after a brief quiet
  // moment, so the previous player finishing a sentence isn't learned as
  // this player's voice.
  function collectVoice(onProgress, onWaiting) {
    return new Promise((resolve, reject) => {
      const lis = voice.listener;
      const need = ENROLL_SECONDS * (VoiceID.RATE / VoiceID.BLOCK);
      const quietNeeded = 40; // 0.4 s
      // Only wait if someone was still talking when this turn began.
      const talking = lis.blocks.slice(-30).some((b) => b.speech);
      let quiet = talking ? 0 : quietNeeded;
      let waiting = false;
      const got = [];
      lis.onBlock = (b) => {
        $('enrollLevel').style.width = `${Math.min(100, Math.round(Math.sqrt(b.rms) * 400))}%`;
        $('enrollLevel').classList.toggle('voiced', b.speech);
        if (quiet < quietNeeded) {
          quiet = b.speech ? 0 : quiet + 1;
          if (b.speech && !waiting) { waiting = true; onWaiting(); }
          return;
        }
        if (!b.speech) return;
        got.push(b.samples);
        onProgress(got.length / need);
        if (got.length >= need) {
          lis.onBlock = null;
          const out = new Float32Array(got.length * VoiceID.BLOCK);
          got.forEach((x, i) => out.set(x, i * VoiceID.BLOCK));
          resolve(out);
        }
      };
      enroll.cancel = (why) => { lis.onBlock = null; reject(why); };
    });
  }

  function waitForGo() {
    return new Promise((resolve, reject) => {
      $('enrollGo').onclick = () => resolve();
      enroll.cancel = (why) => reject(why);
    });
  }

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function enrollPlayers() {
    el.setup.hidden = true;
    el.enroll.hidden = false;
    const names = settings.names;
    const leave = (msg) => {
      el.enroll.hidden = true;
      el.setup.hidden = false;
      setupWarn(msg);
      return false;
    };
    try {
      enrollUI({ title: 'Voice check', prompt: 'Getting the voice model ready…', busy: true });
      await cancellable(VoiceID.loadModel());
    } catch (why) {
      return leave(why === 'back' || why === 'redo' ? '' : 'Couldn’t load the voice model. Reload the page and try again.');
    }
    for (;;) {
      try {
        const profiles = [];
        for (let p = 0; p < 2; p++) {
          const title = `Voice check ${p + 1} of 2`;
          const prompt = `<b>${esc(names[p])}</b>, it’s your turn! Say your name and your favorite Pokémon. Keep talking until the bar is full.`;
          enrollUI({ title, prompt });
          const audio = await collectVoice(
            (x) => enrollUI({ title, prompt, progress: x }),
            () => enrollUI({ title, prompt: `${prompt}<br><small>(Waiting for a quiet moment first…)</small>` }),
          );
          enrollUI({ title, prompt: `Got it, <b>${esc(names[p])}</b>! Learning your voice…`, progress: 1, busy: true });
          profiles.push(await cancellable(VoiceID.enroll(audio)));
          await cancellable(pause(700));
        }
        const distinct = VoiceID.distinctness(profiles[0], profiles[1]);
        el.enroll.dataset.distinctness = distinct.toFixed(2); // handy when debugging
        enrollUI({
          title: 'Ready!',
          prompt: `I know what <b>${esc(names[0])}</b> and <b>${esc(names[1])}</b> sound like. Whoever says the name first gets the point.`,
          progress: 1,
          note: VoiceID.soundAlike(profiles[0], profiles[1])
            ? 'Your voices sound a lot alike, so I may mix you up. When I’m not sure I’ll ask, and if a point goes to the wrong person, tap the right name at the top.'
            : 'If I ever give a point to the wrong person, tap the right name at the top.',
          ready: true,
        });
        $('enrollGo').focus();
        await waitForGo();
        voice.profiles = profiles;
        voice.key = voicesKey();
        el.enroll.hidden = true;
        el.setup.hidden = false;
        syncPlayersUI();
        return true;
      } catch (why) {
        if (why === 'back') return leave('');
        if (why !== 'redo') return leave('Something went wrong with the voice check. Try again.');
      }
    }
  }

  $('enrollRedo').addEventListener('click', () => enroll.cancel && enroll.cancel('redo'));
  $('enrollBack').addEventListener('click', () => enroll.cancel && enroll.cancel('back'));

  // Who was talking just now? Uses the speech since the last wrong guess (that
  // was someone else's try) or the start of the round, at most 4 s back.
  // Resolves to a player index, or null when it can't tell.
  async function whoSpoke() {
    if (!voice.profiles || !voice.listener || !voice.listener.running) return null;
    const since = Math.max(game.uttStart, performance.now() - 4000);
    try {
      const r = await VoiceID.identify(voice.profiles, voice.listener.speechSince(since));
      return r && r.sure ? r.player : null;
    } catch {
      return null;
    }
  }

  // ---------- rounds ----------
  function nextRound() {
    clearTimeout(game.advanceTimer);
    game.idx++;
    if (game.idx >= game.deck.length) return endGame();

    const id = game.deck[game.idx];
    const mode = settings.mode === 'mix' ? (Math.random() < 0.5 ? 'silhouette' : 'outline') : settings.mode;
    game.current = { id, mon: POKEMON[id - 1], mode };
    game.hintLevel = 0;
    game.wrongTries = 0;
    game.lastAward = null;
    game.phase = 'loading';

    // 'instant' disables the filter transition so the old reveal doesn't fade back in color.
    el.stage.className = `stage ${mode} instant`;
    el.reveal.className = 'reveal';
    el.hint.innerHTML = '&nbsp;';
    setHeard('', '');
    el.input.value = '';
    el.playerChips.forEach((c) => c.classList.remove('scored', 'ask'));

    // Keep the silhouette hidden until the image is decoded so the answer never flashes.
    el.mon.style.visibility = 'hidden';
    el.mon.onload = () => {
      el.mon.style.visibility = '';
      requestAnimationFrame(() => el.stage.classList.remove('instant'));
      game.phase = 'guess';
      game.uttStart = performance.now();
      freshRecognizer(); // brand-new speech session: nothing from the last Pokémon carries over
    };
    el.mon.onerror = () => { game.deck.splice(game.idx--, 1); nextRound(); };
    el.mon.src = sprite(id);
    const upcoming = game.deck[game.idx + 1];
    if (upcoming) new Image().src = sprite(upcoming);

    updateStats();
  }

  // player: index of who got it in two-player mode, or null if unknown.
  function reveal(correct, player = null) {
    game.phase = 'reveal';
    pauseRecognizer(); // cheering during the reveal shouldn't count toward the next one
    const { mon } = game.current;
    el.stage.classList.add('revealed');
    el.reveal.innerHTML = `${correct ? "It's " : ''}${esc(mon.name)}!<small>#${String(mon.id).padStart(3, '0')}</small>` +
      (correct && game.players === 2 ? '<span class="who" id="who"></span>' : '');
    el.reveal.className = `reveal show ${correct ? 'good' : 'bad'}`;
    el.hint.innerHTML = '&nbsp;';
    let wait = correct ? REVEAL_MS : REVEAL_MS + 700;
    if (correct) {
      game.score++;
      if (game.players === 2) {
        game.lastAward = { player: null };
        if (player === null) {
          showWho();
          wait = WHO_WAIT_MS;
        } else {
          awardTo(player);
          wait = REVEAL_MS_2P;
        }
      } else {
        game.streak++;
        if (game.streak > game.bestStreak) {
          game.bestStreak = game.streak;
          store.set('wtp.bestStreak', game.bestStreak);
        }
      }
    } else {
      game.streak = 0;
      game.missed.push(mon.id);
    }
    updateStats();
    game.advanceTimer = setTimeout(nextRound, wait);
  }

  function showWho() {
    const who = $('who');
    if (who) who.textContent = 'Who got it? Tap your name at the top';
    el.playerChips.forEach((c) => c.classList.add('ask'));
  }

  // Give (or move) the current round's point to player p.
  function awardTo(p) {
    const prev = game.lastAward.player;
    if (prev === p) return;
    if (prev !== null) game.scores[prev]--;
    game.scores[p]++;
    game.lastAward.player = p;
    const who = $('who');
    if (who) who.textContent = `★ Point to ${game.names[p]}`;
    el.playerChips.forEach((c, i) => {
      c.classList.remove('ask', 'scored');
      if (i === p) { void c.offsetWidth; c.classList.add('scored'); }
    });
    updateStats();
  }

  el.playerChips.forEach((chip, p) => chip.addEventListener('click', () => {
    if (game.phase !== 'reveal' || !game.lastAward) return;
    const wasUnknown = game.lastAward.player === null;
    awardTo(p);
    if (wasUnknown) {
      clearTimeout(game.advanceTimer);
      game.advanceTimer = setTimeout(nextRound, 1200);
    }
  }));

  function updateStats() {
    el.roundStat.textContent = game.deck.length ? `${Math.min(game.idx + 1, game.deck.length)}/${game.deck.length}` : '–';
    el.scoreStat.textContent = game.score;
    el.streakStat.textContent = game.streak;
    el.playerChips.forEach((c, i) => {
      c.querySelector('b').textContent = game.scores[i];
      c.title = `Tap to give this point to ${game.names[i] || `Player ${i + 1}`}`;
    });
  }

  function showHint() {
    if (game.phase !== 'guess') return;
    const name = game.current.mon.name;
    game.hintLevel = Math.min(game.hintLevel + 1, 2);
    if (game.hintLevel === 1) game.hintsUsed++;
    // Level 1: first letter + blanks. Level 2: every other letter.
    let i = 0;
    const masked = [...name].map((ch) => {
      if (!/[a-z]/i.test(ch)) return ch === ' ' ? ' ' : ch;
      const show = i === 0 || (game.hintLevel === 2 && i % 2 === 0);
      i++;
      return show ? ch.toUpperCase() : '_';
    });
    el.hint.textContent = masked.join(' ');
  }

  function skip() {
    if (game.phase === 'guess') reveal(false);
    else if (game.phase === 'reveal') nextRound();
  }

  function endGame() {
    game.phase = 'idle';
    stopMic();
    if (voice.listener) voice.listener.stop();
    const total = game.deck.length;
    const pct = Math.round((game.score / total) * 100);
    if (game.players === 2) {
      const [a, b] = game.scores;
      $('finalScore').textContent = `${a} – ${b}`;
      const lead = a === b ? 'It’s a tie!' : `${game.names[a > b ? 0 : 1]} wins!`;
      $('finalDetail').textContent = `${game.names[0]} ${a}, ${game.names[1]} ${b}. ${lead} Together you got ${game.score} of ${total}.`;
    } else {
      $('finalScore').textContent = `${game.score} / ${total}`;
      const verdict = pct === 100 ? 'Pokémon Master!' : pct >= 80 ? 'Gym Leader material.' : pct >= 50 ? 'Solid trainer.' : 'Time to hit the tall grass.';
      $('finalDetail').textContent = `${pct}% · ${verdict} Best streak ever: ${game.bestStreak}.` +
        (game.hintsUsed ? ` Hints used: ${game.hintsUsed}.` : '');
    }
    $('missedWrap').hidden = !game.missed.length;
    $('missed').innerHTML = game.missed.map((id) =>
      `<li><img src="${sprite(id)}" alt="" loading="lazy">${esc(POKEMON[id - 1].name)}</li>`).join('');
    el.setup.hidden = true;
    el.enroll.hidden = true;
    el.results.hidden = false;
    el.overlay.hidden = false;
    $('againBtn').focus();
  }

  // ---------- guessing ----------
  const COMMANDS = {
    skip: ['skip', 'pass', 'next', 'give up', 'i give up', 'i dont know', 'no idea'],
    hint: ['hint', 'clue', 'give me a hint', 'help'],
  };

  function command(text) {
    const t = normalize(text);
    for (const [cmd, phrases] of Object.entries(COMMANDS)) if (phrases.includes(t)) return cmd;
    return null;
  }

  // Returns 'won', 'missed' (a finished wrong guess), 'command', 'pending' or 'ignored'.
  function tryGuess(alternatives, { final, spoken }) {
    if (game.phase !== 'guess') return 'ignored';
    const { threshold, margin, interimMin, autoHintAfter } = rules();
    const r = judge(alternatives, game.current.id, final ? threshold : Math.max(threshold, interimMin), margin);
    if (r.accepted) {
      setHeard(alternatives[0], 'good');
      if (game.players === 2 && spoken) {
        // Work out who said it (takes a few milliseconds), then reveal.
        game.phase = 'judging';
        pauseRecognizer();
        whoSpoke().then((p) => { if (game.phase === 'judging') reveal(true, p); });
      } else {
        reveal(true, null);
      }
      return 'won';
    }
    if (!final) return 'pending';

    game.uttStart = performance.now(); // the next voice heard is a new try, maybe by someone else
    const cmd = command(alternatives[0]);
    if (cmd === 'skip') return skip(), 'command';
    if (cmd === 'hint') return showHint(), 'command';

    if (r.bestScore >= 0.7) setHeard(`Not ${POKEMON[r.bestId - 1].name}…`, 'bad');
    else setHeard(`“${alternatives[0]}” — try again`, 'bad');
    game.wrongTries++;
    if (autoHintAfter && game.wrongTries % autoHintAfter === 0) showHint();
    el.stage.classList.remove('shake');
    void el.stage.offsetWidth; // restart the animation
    el.stage.classList.add('shake');
    return 'missed';
  }

  function setHeard(text, cls) {
    el.heard.textContent = text || ' ';
    el.heard.className = cls || '';
  }

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = el.input.value.trim();
    if (!v) return;
    if (tryGuess([v], { final: true, spoken: false }) !== 'won') el.input.select();
  });

  // ---------- voice ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // `rec` is the one live recognizer. Events from any older one are ignored, so
  // replacing it is how we wipe everything heard so far.
  const mic = { rec: null, wanted: false, engine: null, restartTimer: 0 };

  // Where the audio goes. Preference order:
  //   local  – the browser's on-device model (Chrome/Edge 139+ `processLocally`); nothing leaves the Mac
  //   apple  – Safari, which uses Apple's speech recognizer instead of Google's
  //   cloud  – Chrome's default, which streams audio to Google
  const ENGINE_LABEL = { local: 'on-device', apple: 'Apple', cloud: 'Google cloud' };
  const isSafari = /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|edg|opr/i.test(navigator.userAgent);
  const LOCAL_OPTS = { langs: ['en-US'], processLocally: true };

  async function pickEngine() {
    if (typeof SR.available === 'function') {
      try {
        let status = await SR.available(LOCAL_OPTS);
        if (status === 'downloadable' || status === 'downloading') {
          micUI('Downloading on-device speech model (one time)…');
          status = (await SR.install(LOCAL_OPTS)) ? 'available' : 'unavailable';
        }
        if (status === 'available') return 'local';
      } catch { /* fall through */ }
    }
    return isSafari ? 'apple' : 'cloud';
  }

  function micUI(status) {
    el.micBtn.setAttribute('aria-pressed', String(mic.wanted));
    el.micStatus.textContent = status;
  }

  function makeRecognizer(engine) {
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;

    if (engine === 'local') {
      rec.processLocally = true;
      // Bias the on-device model toward Pokémon names so "pikachu" isn't heard as "pick a chew".
      if ('phrases' in rec && typeof SpeechRecognitionPhrase === 'function') {
        try {
          const names = [...new Set(POKEMON.map((p) => p.name.replace(/[♀♂]/g, '')))];
          rec.phrases = names.map((n) => new SpeechRecognitionPhrase(n, 3));
        } catch { /* biasing is optional */ }
      }
    }

    rec.onstart = () => {
      if (rec !== mic.rec) return;
      micUI(`Listening (${ENGINE_LABEL[engine]})… say the Pokémon’s name`);
    };
    rec.onresult = (e) => {
      if (rec !== mic.rec || game.phase !== 'guess') return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alts = Array.from(res, (a) => a.transcript.trim()).filter(Boolean);
        if (!alts.length) continue;
        if (!res.isFinal) setHeard(alts[0], 'interim');
        const outcome = tryGuess(alts, { final: res.isFinal, spoken: true });
        if (outcome === 'won') return; // the next round starts its own session
        if (outcome === 'missed' || outcome === 'command') {
          // Start the next try from a clean slate so old words can't pile up.
          if (game.phase === 'guess') freshRecognizer();
          return;
        }
      }
    };
    rec.onerror = (e) => {
      if (rec !== mic.rec) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        mic.wanted = false;
        micUI('Microphone blocked — allow mic access in the address bar');
      } else if (e.error === 'network') {
        micUI('Speech service unreachable (needs internet in Chrome)');
      } else if (engine === 'local' && (e.error === 'language-not-supported' || e.error === 'phrases-not-supported')) {
        // The on-device model couldn't be used after all; retry with the browser's default engine.
        mic.engine = isSafari ? 'apple' : 'cloud';
      }
      // 'no-speech' and 'aborted' are routine; onend restarts us.
    };
    rec.onend = () => {
      if (rec !== mic.rec) return; // an old session we already replaced
      mic.rec = null;
      if (mic.wanted) {
        // Browsers end sessions after silence; quietly start a new one.
        mic.restartTimer = setTimeout(startRecognizer, 250);
      } else {
        micUI('Mic off — tap to talk');
      }
    };
    return rec;
  }

  function startRecognizer() {
    clearTimeout(mic.restartTimer);
    if (!mic.wanted || mic.rec || !mic.engine) return;
    const rec = makeRecognizer(mic.engine);
    mic.rec = rec;
    try {
      rec.start();
    } catch {
      mic.rec = null;
      mic.restartTimer = setTimeout(startRecognizer, 500);
    }
  }

  // Throw away the current session (and everything it heard).
  function pauseRecognizer() {
    clearTimeout(mic.restartTimer);
    const old = mic.rec;
    mic.rec = null;
    if (old) try { old.abort(); } catch {}
    return old;
  }

  // Throw away the current session and open a new one.
  function freshRecognizer() {
    if (!SR || !mic.wanted) return;
    const old = pauseRecognizer();
    // Give the old session a moment to release the mic before opening a new one.
    mic.restartTimer = setTimeout(startRecognizer, old ? 200 : 0);
  }

  async function startMic() {
    if (!SR) return;
    mic.wanted = true;
    micUI('Starting mic…');
    if (!mic.engine) mic.engine = await pickEngine();
    if (mic.wanted && !mic.rec) freshRecognizer();
  }

  function stopMic() {
    mic.wanted = false;
    pauseRecognizer();
    micUI('Mic off — tap to talk');
  }

  if (!SR) {
    el.micBtn.disabled = true;
    el.micStatus.textContent = 'Voice not supported in this browser — type below';
    $('noVoice').hidden = false;
  }

  el.micBtn.addEventListener('click', () => (mic.wanted ? stopMic() : startMic()));

  // ---------- buttons & keys ----------
  $('hintBtn').addEventListener('click', showHint);
  $('skipBtn').addEventListener('click', skip);
  $('startBtn').addEventListener('click', onStart);
  $('againBtn').addEventListener('click', () => {
    el.results.hidden = true;
    el.setup.hidden = false;
    syncPlayersUI();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === el.input || e.target.tagName === 'INPUT' || !el.overlay.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); el.micBtn.click(); }
    else if (k === '?') showHint();
    else if (k === 'ArrowRight') skip();
    else if (/^[a-z]$/i.test(k)) el.input.focus(); // just start typing to guess
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.input.blur();
  });

  $('startBtn').focus();
})();
