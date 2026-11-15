# Companion side-key alignment — 2026-11-15

Scope: IMPLEMENTATION_PLAN Phase 8, hardening; one owner-requested correction
to the physical-button hints on the companion. No new product decisions.

The owner reported that the on-screen Menu/Open/Back marks did not line up
with the case buttons. The firmware copied symmetric mockup positions and
duplicated them in Focus, Tasks, Timer, Games, and the emergency hold overlay.

With USB pointing down, the approximate case-button centres are -45 degrees
(upper PWR) and +40 degrees (lower BOOT), clockwise from the right axis. Source:
[Waveshare case drawing](https://www.waveshare.com/img/devkit/ESP32-S3-Touch-AMOLED-1.75C/ESP32-S3-Touch-AMOLED-1.75C-details-size.jpg).
These are estimates from the drawing, not toleranced mechanical measurements.

All labels now use one placement helper. Their tangent rim markers share the
same anchors, at radius 228 px, outside the home orbit dots and inside the
233 px panel radius. Button actions and input mappings are unchanged.

Visual checking also exposed ordinary Menu text painting over the hold
overlay's Hold text. Key hints now sit below that opaque overlay. A pixel
regression failed before this stacking fix and passes afterwards. The Focus
screenshot scenario was updated to open Focus through the menu, matching the
existing navigation; the old scenario incorrectly captured Home.

Validation:

- Added an angular-alignment regression to the real LVGL menu test. Both
  checks failed against the previous layout and passed after the correction.
- `cmake --build firmware/companion/sim/build -j8`: passed.
- `ctest --test-dir firmware/companion/sim/build -j8 --output-on-failure`:
  59/59 passed, including round-display clipping and partial redraw checks.
- `idf.py build` with the existing local ESP-IDF environment: passed.
- Generated simulator renders of home, menu, Focus, Tasks, Timer, Games and
  the emergency hold overlay for visual inspection.
- `git diff --check`: passed.

The owner initially requested simulator-only validation, then reconnected the
board and requested installation. `idf.py -p /dev/cu.usbmodem101 app-flash`
completed with written-data hash verification. A subsequent reset and 12-second
serial check confirmed startup with pairing preserved and lost mode off; no
panic, abort, UI-start or input-start fault was detected. Only the application
partition was flashed.

Visual acceptance on the physical case remains pending: compare both markers
with the actual buttons and adjust the approximate angles if needed.

Owner follow-up: the upper physical button is longer than the lower one.
Increased only the upper marker's tangent half-length from 9 to 13 px;
both anchors and the lower marker remain at their previous positions.
Follow-up validation: simulator build passed; `ctest --test-dir
firmware/companion/sim/build -R '^(test_screens|test_screen_damage|sim_shot_smoke)$'
--output-on-failure` passed 3/3. Inspected the updated menu render. IDF build
and app-flash passed with hash verification. An 8-second boot check confirmed
pairing and Wi-Fi startup, without detected startup faults.

Second length adjustment requested by the owner: lower half-length 13 px
(the previous upper length), upper half-length 20 px (13 x 1.5, rounded).
The paint bounds were enlarged to 36 px so the longer stroke and rounded caps
are not clipped. Anchors remain unchanged. The same three simulator checks
passed 3/3, and the updated menu render was inspected. IDF build and app-flash
passed with written-data hash verification.
