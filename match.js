// Pokémon data + fuzzy "close enough" matching for spoken or typed guesses.
// Works in the browser (window.PokeMatch) and in Node (module.exports) for testing.
(function (root) {
  // [display name, ...extra spoken/typed aliases]
  const RAW = [
    ['Bulbasaur', 'bulba saur'], ['Ivysaur', 'ivy saur'], ['Venusaur', 'venus saur'],
    ['Charmander'], ['Charmeleon', 'charm alien'], ['Charizard'],
    ['Squirtle'], ['Wartortle', 'war turtle'], ['Blastoise', 'blast toise'],
    ['Caterpie', 'caterpillar'], ['Metapod'], ['Butterfree', 'butter free'],
    ['Weedle'], ['Kakuna', 'kahuna'], ['Beedrill', 'bee drill'],
    ['Pidgey'], ['Pidgeotto', 'pidgey otto'], ['Pidgeot'],
    ['Rattata', 'ratatta', 'rat a tat'], ['Raticate', 'rat icate'],
    ['Spearow', 'spear oh', 'sparrow'], ['Fearow', 'fear oh', 'fear row'],
    ['Ekans'], ['Arbok', 'our bok'],
    ['Pikachu', 'pika chu'], ['Raichu', 'rye chu', 'rai chu'],
    ['Sandshrew', 'sand shrew'], ['Sandslash', 'sand slash'],
    ['Nidoran♀', 'nidoran', 'nidoran female', 'female nidoran', 'nidoran girl'],
    ['Nidorina'], ['Nidoqueen', 'nido queen'],
    ['Nidoran♂', 'nidoran', 'nidoran male', 'male nidoran', 'nidoran boy'],
    ['Nidorino'], ['Nidoking', 'nido king'],
    ['Clefairy', 'clef fairy'], ['Clefable'],
    ['Vulpix'], ['Ninetales', 'nine tails'],
    ['Jigglypuff', 'jiggly puff'], ['Wigglytuff', 'wiggly tuff'],
    ['Zubat', 'zoo bat'], ['Golbat', 'gold bat'],
    ['Oddish', 'odd ish'], ['Gloom'], ['Vileplume', 'vile plume'],
    ['Paras', 'paris'], ['Parasect', 'para sect'],
    ['Venonat', 'venom nat'], ['Venomoth', 'venom moth'],
    ['Diglett', 'dig let'], ['Dugtrio', 'dug trio'],
    ['Meowth', 'meow'], ['Persian'],
    ['Psyduck', 'psy duck', 'sy duck'], ['Golduck', 'gold duck'],
    ['Mankey', 'monkey'], ['Primeape', 'prime ape'],
    ['Growlithe', 'growlith'], ['Arcanine', 'arcana nine'],
    ['Poliwag', 'polly wag'], ['Poliwhirl', 'polly whirl'], ['Poliwrath', 'polly wrath'],
    ['Abra'], ['Kadabra', 'cadabra'], ['Alakazam', 'ala kazam'],
    ['Machop', 'ma chop'], ['Machoke', 'ma choke'], ['Machamp', 'ma champ'],
    ['Bellsprout', 'bell sprout'], ['Weepinbell', 'weeping bell'], ['Victreebel', 'victory bell'],
    ['Tentacool', 'tentacle'], ['Tentacruel', 'tentacle cruel'],
    ['Geodude', 'geo dude'], ['Graveler', 'graveller'], ['Golem'],
    ['Ponyta', 'pony ta'], ['Rapidash', 'rapid dash'],
    ['Slowpoke', 'slow poke'], ['Slowbro', 'slow bro'],
    ['Magnemite', 'magnet mite', 'magna mite'], ['Magneton', 'magnet on'],
    ["Farfetch'd", 'farfetched', 'far fetched'],
    ['Doduo', 'dodo'], ['Dodrio'],
    ['Seel', 'seal'], ['Dewgong', 'dew gong'],
    ['Grimer', 'grimmer'], ['Muk', 'muck'],
    ['Shellder', 'shell der'], ['Cloyster', 'cloister'],
    ['Gastly', 'ghastly'], ['Haunter', 'haunt her'], ['Gengar'],
    ['Onix', 'onyx'],
    ['Drowzee', 'drowsy'], ['Hypno'],
    ['Krabby', 'crabby'], ['Kingler'],
    ['Voltorb', 'volt orb'], ['Electrode'],
    ['Exeggcute', 'egg execute', 'eggsecute'], ['Exeggutor', 'egg executor', 'eggsecutor'],
    ['Cubone', 'cue bone'], ['Marowak', 'marrow wack'],
    ['Hitmonlee', 'hitman lee'], ['Hitmonchan', 'hitman chan'],
    ['Lickitung', 'lick it tongue', 'lickitongue'],
    ['Koffing', 'coughing'], ['Weezing', 'wheezing'],
    ['Rhyhorn', 'rye horn'], ['Rhydon', 'rye don'],
    ['Chansey', 'chancy'], ['Tangela', 'tangle a'], ['Kangaskhan', 'kangaskan'],
    ['Horsea', 'horse sea', 'horsey'], ['Seadra', 'sea dra'],
    ['Goldeen', 'gold een'], ['Seaking', 'sea king'],
    ['Staryu', 'star you'], ['Starmie', 'star me'],
    ['Mr. Mime', 'mister mime', 'mr mime'],
    ['Scyther', 'scythe er', 'sigher'], ['Jynx', 'jinx'],
    ['Electabuzz', 'electa buzz'], ['Magmar', 'magma'],
    ['Pinsir', 'pincer'], ['Tauros', 'taurus'],
    ['Magikarp', 'magic carp'], ['Gyarados'],
    ['Lapras'], ['Ditto'],
    ['Eevee', 'evie'], ['Vaporeon'], ['Jolteon'], ['Flareon'],
    ['Porygon', 'polygon'],
    ['Omanyte', 'oh my night'], ['Omastar', 'oma star'],
    ['Kabuto'], ['Kabutops', 'kabuto ops'],
    ['Aerodactyl', 'aero dactyl', 'pterodactyl'],
    ['Snorlax', 'snore lax'],
    ['Articuno', 'arctic uno'], ['Zapdos', 'zap dos'], ['Moltres', 'mol tres'],
    ['Dratini'], ['Dragonair', 'dragon air'], ['Dragonite', 'dragon ite'],
    ['Mewtwo', 'mew two'], ['Mew'],
  ];

  const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

  function normalize(s) {
    return s
      .toLowerCase()
      .replace(/♀/g, '').replace(/♂/g, '')
      .replace(/\d/g, (d) => ' ' + DIGITS[+d] + ' ')
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Rough English sound-alike key so "pick a chew" ≈ "pikachu", "crabby" ≈ "krabby".
  function phonetic(s) {
    return s
      .replace(/[^a-z]/g, '')
      .replace(/ph/g, 'f')
      .replace(/ck/g, 'k')
      .replace(/kn/g, 'n')
      .replace(/gh/g, 'g')
      .replace(/wh/g, 'w')
      .replace(/q/g, 'k')
      .replace(/x/g, 'ks')
      .replace(/c(?=[eiy])/g, 's')
      .replace(/c/g, 'k')
      .replace(/z/g, 's')
      .replace(/(ee|ea|ie|ey)/g, 'i')
      .replace(/y/g, 'i')
      .replace(/(oo|ou|ew|ue)/g, 'u')
      .replace(/([a-z])\1+/g, '$1')
      .replace(/(.)e$/, '$1');
  }

  function skeleton(p) {
    return p.charAt(0) + p.slice(1).replace(/[aeiou]/g, '');
  }

  function keys(joined) {
    const p = phonetic(joined);
    return { raw: joined, phon: p, skel: skeleton(p) };
  }

  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  function sim(a, b) {
    const m = Math.max(a.length, b.length);
    return m === 0 ? 0 : 1 - lev(a, b) / m;
  }

  function score(h, c) {
    return Math.max(sim(h.raw, c.raw), sim(h.phon, c.phon), 0.85 * sim(h.skel, c.skel));
  }

  const POKEMON = RAW.map(([name, ...aliases], i) => {
    const forms = [name, ...aliases].map((f) => normalize(f).replace(/ /g, ''));
    return {
      id: i + 1,
      name,
      candidates: [...new Set(forms)].map(keys),
    };
  });

  // Every 1–3 word run of what was heard, glued together ("bulb a sore" → "bulbasore").
  function windows(heard) {
    const words = normalize(heard).split(' ').filter(Boolean);
    const out = new Set();
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        out.add(words.slice(i, i + n).join(''));
      }
    }
    return [...out].map(keys);
  }

  // Best score for each Pokémon across all recognizer alternatives.
  function rank(heardList) {
    const ws = heardList.flatMap(windows);
    const scores = new Float64Array(POKEMON.length + 1);
    if (!ws.length) return scores;
    for (const p of POKEMON) {
      let best = 0;
      for (const c of p.candidates) for (const w of ws) best = Math.max(best, score(w, c));
      scores[p.id] = best;
    }
    return scores;
  }

  // Accept when the target is at least `threshold` similar AND no other Pokémon
  // is a strictly better match (so "Charmander" never passes for Charmeleon).
  function judge(heardList, targetId, threshold) {
    const scores = rank(heardList);
    let bestId = 0;
    for (let id = 1; id < scores.length; id++) if (scores[id] > scores[bestId] || !bestId) bestId = id;
    const target = scores[targetId];
    return {
      accepted: target >= threshold && target >= scores[bestId] - 1e-9,
      targetScore: target,
      bestId,
      bestScore: scores[bestId],
    };
  }

  const api = { POKEMON, normalize, phonetic, judge, rank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokeMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
