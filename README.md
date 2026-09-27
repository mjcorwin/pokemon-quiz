# Who's That Pokémon?

Guess the original 151 Pokémon from their shadow or outline. Say the name out loud (or type it) and close-enough guesses count.

## Run

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 in **Google Chrome**, Edge or Safari and allow the microphone.

- Voice uses the browser's Web Speech API. Firefox doesn't support it, and Fedora's `chromium` package usually fails with a "network" error because it has no Google speech keys. Use Google Chrome.
- Serve it over `localhost` instead of opening the file directly, so the mic permission is remembered.

## Playing

- The mic stays on. Just say the name. "Skip", "pass" or "I don't know" gives up the round, and "hint" shows letters.
- Keys: `Space` turns the mic on or off, `?` shows a hint, `→` skips, and typing any letter starts a typed guess.
- **Lenient / Normal / Strict** controls how close a guess has to be. A guess is only accepted if the right Pokémon is also the closest match overall, so "Charmander" never counts for Charmeleon.

## Files

- `match.js`: the Pokémon list, spoken aliases and the fuzzy/sound-alike matcher (loads in Node too: `node -e "console.log(require('./match.js').judge(['pick a chew'], 25, 0.62))"`)
- `app.js`: the game loop and speech recognition
- `sprites/`: official artwork for #1–151, from [PokeAPI/sprites](https://github.com/PokeAPI/sprites)
