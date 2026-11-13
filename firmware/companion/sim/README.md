# Companion host simulator

Build and run the host tests from the repository root:

```sh
cmake -S firmware/companion/sim -B firmware/companion/sim/build
cmake --build firmware/companion/sim/build -j8
ctest --test-dir firmware/companion/sim/build --output-on-failure
```

The simulator can write a quiet, short mono WAV for a cue preview:

```sh
firmware/companion/sim/build/companion_sim --cue joy --out joy.wav
```

Cue names are `joy`, `elation`, `surprise`, `fright`, and `tender`.
This direct preview has no active character context. To exercise the actual
UI event and its night/focus suppression, use a simulated task confirmation:

```sh
firmware/companion/sim/build/companion_sim --event-cue task-complete --out event.wav
firmware/companion/sim/build/companion_sim --event-cue task-complete --hour 23 --out night.wav
```

The second command exits 3 and does not create a WAV because the event occurs
at night. The cue renderer and UI cue callback compile only in the host
simulator; they do not open an audio device and are excluded from firmware.
The five cue sounds are provisional pending owner review. Further gesture and
sensor event producers arrive in later stages.
