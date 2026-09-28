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

- A small neural network recognizes the voices. It turns speech into a 512-number "voiceprint" that describes the voice rather than the words, and each guess goes to the closest player.
- Parents and kids, or two adults, are told apart very reliably. Two kids of a similar age are harder. The voice check warns you if your voices sound very alike, and when the game isn't sure it asks "Who got it?" instead of guessing.
- If a point goes to the wrong person, tap the right name in the top bar while the answer is showing. Typed guesses also ask who got it.
- The voice check is skipped on the next game if the names are the same. "Redo the voice check" on the setup screen starts it over.
- Everything runs in the browser. The model and its runtime are in this repo, audio never leaves the computer, and voiceprints are forgotten when you close the tab. One-player mode never loads the model.

## Where the audio goes

The mic status line shows which speech engine is in use. The app prefers, in order:

1. **on-device**: Chrome or Edge 139+ can run speech recognition locally (`processLocally`). The first time, the browser downloads a small language pack; after that nothing leaves the machine. The app also feeds the on-device model the Pokémon names so it is biased toward hearing them.
2. **Apple**: Safari uses Apple's recognizer rather than Google's.
3. **Google cloud**: Chrome's default when on-device isn't available. Audio is streamed to Google.

## Files

- `match.js`: the Pokémon list, spoken aliases and the fuzzy/sound-alike matcher (loads in Node too: `node -e "console.log(require('./match.js').judge(['pick a chew'], 25, 0.62))"`)
- `app.js`: the game loop and speech recognition. Every Pokémon, and every wrong try, gets a brand-new recognizer session so nothing heard earlier carries over.
- `voiceid.js`: two-player voice ID. Captures the mic with an AudioWorklet (`voice-worklet.js`), resamples to 16 kHz, computes Kaldi-style 80-band filterbank features, and runs the speaker model with ONNX Runtime Web.
- `models/speaker-campplus-fp16.onnx`: the speaker model, [WeSpeaker](https://github.com/wenet-e2e/wespeaker) CAM++ trained on VoxCeleb, from the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) export, with weights stored as 16-bit floats. Licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), following the VoxCeleb dataset.
- `vendor/onnxruntime-web/`: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0, WebAssembly build only, MIT licensed.
- `sprites/`: official artwork for #1–151, from [PokeAPI/sprites](https://github.com/PokeAPI/sprites)
