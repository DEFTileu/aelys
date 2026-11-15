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

The owner requested simulator-only validation for now. No firmware was flashed.
Hardware installation and visual acceptance remain pending. Next step when
the owner resumes hardware testing: flash the app partition and compare both
markers with the actual case; adjust the approximate angles if needed.
