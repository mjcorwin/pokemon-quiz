(() => {
  const { POKEMON, judge, normalize } = window.PokeMatch;
  const $ = (id) => document.getElementById(id);

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

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const settings = Object.assign(
    { mode: 'silhouette', rounds: '25', strictness: 'normal' },
    store.get('wtp.settings', {})
  );

  const game = {
    deck: [], idx: 0, current: null, phase: 'idle',
    score: 0, streak: 0, bestStreak: store.get('wtp.bestStreak', 0),
    hintLevel: 0, hintsUsed: 0, missed: [], advanceTimer: 0, wrongTries: 0,
  };

  const el = {
    stage: $('stage'), mon: $('mon'), reveal: $('reveal'), hint: $('hint'),
    micBtn: $('micBtn'), micStatus: $('micStatus'), heard: $('heard'),
    form: $('guessForm'), input: $('guessInput'), names: $('names'),
    roundStat: $('roundStat'), scoreStat: $('scoreStat'), streakStat: $('streakStat'),
    overlay: $('overlay'), setup: $('setup'), results: $('results'),
  };

  const sprite = (id) => `sprites/${id}.png`;

  // ---------- setup screen ----------
  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.setting;
    const sync = () => seg.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.value === settings[key])));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = b.dataset.value;
      store.set('wtp.settings', settings);
      sync();
    });
    sync();
  }
  el.names.innerHTML = POKEMON.map((p) => `<option value="${p.name}">`).join('');

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startGame() {
    const n = Math.min(Number(settings.rounds), POKEMON.length);
    Object.assign(game, {
      deck: shuffle(POKEMON.map((p) => p.id)).slice(0, n),
      idx: -1, score: 0, streak: 0, hintsUsed: 0, missed: [],
    });
    el.overlay.hidden = true;
    nextRound();
    if (SR && !mic.wanted) startMic();
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
    game.phase = 'loading';
    mic.ignoreBelow = mic.lastLength; // drop any speech still in flight from last round

    // 'instant' disables the filter transition so the old reveal doesn't fade back in color.
    el.stage.className = `stage ${mode} instant`;
    el.reveal.className = 'reveal';
    el.hint.innerHTML = '&nbsp;';
    setHeard('', '');
    el.input.value = '';

    // Keep the silhouette hidden until the image is decoded so the answer never flashes.
    el.mon.style.visibility = 'hidden';
    el.mon.onload = () => {
      el.mon.style.visibility = '';
      requestAnimationFrame(() => el.stage.classList.remove('instant'));
      game.phase = 'guess';
    };
    el.mon.onerror = () => { game.deck.splice(game.idx--, 1); nextRound(); };
    el.mon.src = sprite(id);
    const upcoming = game.deck[game.idx + 1];
    if (upcoming) new Image().src = sprite(upcoming);

    updateStats();
  }

  function reveal(correct) {
    game.phase = 'reveal';
    const { mon } = game.current;
    el.stage.classList.add('revealed');
    el.reveal.innerHTML = `${correct ? "It's " : ''}${mon.name}!<small>#${String(mon.id).padStart(3, '0')}</small>`;
    el.reveal.className = `reveal show ${correct ? 'good' : 'bad'}`;
    el.hint.innerHTML = '&nbsp;';
    if (correct) {
      game.score++;
      game.streak++;
      if (game.streak > game.bestStreak) {
        game.bestStreak = game.streak;
        store.set('wtp.bestStreak', game.bestStreak);
      }
    } else {
      game.streak = 0;
      game.missed.push(mon.id);
    }
    updateStats();
    game.advanceTimer = setTimeout(nextRound, correct ? REVEAL_MS : REVEAL_MS + 700);
  }

  function updateStats() {
    el.roundStat.textContent = game.deck.length ? `${Math.min(game.idx + 1, game.deck.length)}/${game.deck.length}` : '–';
    el.scoreStat.textContent = game.score;
    el.streakStat.textContent = game.streak;
  }

  function showHint() {
    if (game.phase !== 'guess') return;
    const name = game.current.mon.name;
    game.hintLevel = Math.min(game.hintLevel + 1, 2);
    if (game.hintLevel === 1) game.hintsUsed++;
    // Level 1: first letter + blanks. Level 2: every other letter.
    let i = 0;
    const masked = [...name].map((ch) => {
      if (!/[a-z]/i.test(ch)) return ch === ' ' ? ' ' : ch;
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
    const total = game.deck.length;
    $('finalScore').textContent = `${game.score} / ${total}`;
    const pct = Math.round((game.score / total) * 100);
    const verdict = pct === 100 ? 'Pokémon Master!' : pct >= 80 ? 'Gym Leader material.' : pct >= 50 ? 'Solid trainer.' : 'Time to hit the tall grass.';
    $('finalDetail').textContent = `${pct}% · ${verdict} Best streak ever: ${game.bestStreak}.` +
      (game.hintsUsed ? ` Hints used: ${game.hintsUsed}.` : '');
    $('missedWrap').hidden = !game.missed.length;
    $('missed').innerHTML = game.missed.map((id) =>
      `<li><img src="${sprite(id)}" alt="" loading="lazy">${POKEMON[id - 1].name}</li>`).join('');
    el.setup.hidden = true;
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

  // Returns true if the round was won.
  function tryGuess(alternatives, { final }) {
    if (game.phase !== 'guess') return false;
    const { threshold, margin, interimMin, autoHintAfter } = rules();
    const r = judge(alternatives, game.current.id, final ? threshold : Math.max(threshold, interimMin), margin);
    if (r.accepted) {
      setHeard(alternatives[0], 'good');
      reveal(true);
      return true;
    }
    if (!final) return false;

    const cmd = command(alternatives[0]);
    if (cmd === 'skip') return skip(), false;
    if (cmd === 'hint') return showHint(), false;

    if (r.bestScore >= 0.7) setHeard(`Not ${POKEMON[r.bestId - 1].name}…`, 'bad');
    else setHeard(`“${alternatives[0]}” — try again`, 'bad');
    game.wrongTries++;
    if (autoHintAfter && game.wrongTries % autoHintAfter === 0) showHint();
    el.stage.classList.remove('shake');
    void el.stage.offsetWidth; // restart the animation
    el.stage.classList.add('shake');
    return false;
  }

  function setHeard(text, cls) {
    el.heard.textContent = text || ' ';
    el.heard.className = cls || '';
  }

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = el.input.value.trim();
    if (!v) return;
    if (!tryGuess([v], { final: true })) el.input.select();
  });

  // ---------- voice ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = { rec: null, wanted: false, running: false, ignoreBelow: 0, lastLength: 0, engine: null };

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
      mic.running = true;
      mic.ignoreBelow = 0;
      mic.lastLength = 0;
      micUI(`Listening (${ENGINE_LABEL[engine]})… say the Pokémon’s name`);
    };
    rec.onresult = (e) => {
      mic.lastLength = e.results.length;
      for (let i = Math.max(e.resultIndex, mic.ignoreBelow); i < e.results.length; i++) {
        const res = e.results[i];
        const alts = Array.from(res, (a) => a.transcript.trim()).filter(Boolean);
        if (!alts.length) continue;
        if (game.phase !== 'guess') continue;
        if (!res.isFinal) setHeard(alts[0], 'interim');
        if (tryGuess(alts, { final: res.isFinal })) {
          mic.ignoreBelow = e.results.length; // don't re-judge the rest of this utterance
          break;
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        mic.wanted = false;
        micUI('Microphone blocked — allow mic access in the address bar');
      } else if (e.error === 'network') {
        micUI('Speech service unreachable (needs internet in Chrome)');
      } else if (engine === 'local' && (e.error === 'language-not-supported' || e.error === 'phrases-not-supported')) {
        // The on-device model couldn't be used after all; retry with the browser's default engine.
        mic.engine = isSafari ? 'apple' : 'cloud';
        mic.rec = null;
      }
      // 'no-speech' and 'aborted' are routine; onend restarts us.
    };
    rec.onend = () => {
      mic.running = false;
      if (mic.wanted) {
        // Chrome ends sessions after silence; quietly start a new one.
        setTimeout(() => { if (mic.wanted && !mic.running) safeStart(); }, 250);
      } else {
        micUI('Mic off — tap to talk');
      }
    };
    return rec;
  }

  function safeStart() {
    mic.rec = mic.rec || makeRecognizer(mic.engine);
    try { mic.rec.start(); } catch { /* already started */ }
  }

  async function startMic() {
    if (!SR) return;
    mic.wanted = true;
    micUI('Starting mic…');
    if (!mic.engine) mic.engine = await pickEngine();
    if (mic.wanted && !mic.running) safeStart();
  }

  function stopMic() {
    mic.wanted = false;
    if (mic.rec) try { mic.rec.stop(); } catch {}
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
  $('startBtn').addEventListener('click', startGame);
  $('againBtn').addEventListener('click', () => {
    el.results.hidden = true;
    el.setup.hidden = false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === el.input || !el.overlay.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
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
