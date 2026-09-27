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
- **Kid / Lenient / Normal / Strict** controls how close a guess has to be. A guess is only accepted if the right Pokémon is also the closest match overall, so "Charmander" never counts for Charmeleon.
- **Kid** is for little kids: a much lower bar, a bit of slack when another Pokémon scores slightly higher, partial speech counts sooner, and a hint appears automatically after every two wrong tries.

## Two players

Pick **2 players** and type both names. Before the first game each player talks for a few seconds ("say your name and your favorite Pokémon") so the game learns their voice. After that, whoever says the name first gets the point.

- It tells voices apart by pitch and vocal tone. A parent and a child, or two adults, are easy. Two kids of a similar age can get mixed up now and then, and the game warns you if your voices sound very alike.
- If a point goes to the wrong person, tap the right name in the top bar while the answer is showing. Typed guesses ask "Who got it?" and wait for a tap.
- The voice check is skipped on the next game if the names are the same. "Redo the voice check" on the setup screen starts it over.
- Voice ID runs entirely in the browser (`voiceid.js`). Nothing is recorded, saved or sent anywhere, and the voice models are forgotten when you close the tab.

## Where the audio goes

The mic status line shows which speech engine is in use. The app prefers, in order:

1. **on-device**: Chrome or Edge 139+ can run speech recognition locally (`processLocally`). The first time, the browser downloads a small language pack; after that nothing leaves the machine. The app also feeds the on-device model the Pokémon names so it is biased toward hearing them.
2. **Apple**: Safari uses Apple's recognizer rather than Google's.
3. **Google cloud**: Chrome's default when on-device isn't available. Audio is streamed to Google.

## Files

- `match.js`: the Pokémon list, spoken aliases and the fuzzy/sound-alike matcher (loads in Node too: `node -e "console.log(require('./match.js').judge(['pick a chew'], 25, 0.62))"`)
- `app.js`: the game loop and speech recognition. Every Pokémon, and every wrong try, gets a brand-new recognizer session so nothing heard earlier carries over.
- `voiceid.js`: on-device speaker identification for two-player mode (pitch + MFCC features, one Gaussian per player)
- `sprites/`: official artwork for #1–151, from [PokeAPI/sprites](https://github.com/PokeAPI/sprites)
