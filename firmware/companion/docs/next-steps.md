# Companion firmware: carry-over after plan 1

Plan 1 (`docs/superpowers/plans/2026-11-12-companion-firmware-base.md`) is done. These points came out of its reviews and must be picked up later.

## Contracts to change before plan 3
- `UI_EV_OWNER` carries a pointer to a sender buffer. Today the only sender is synchronous at boot. Once data arrives from the app, the buffer must stay unchanged until the UI has copied it: double-buffer in the sender or have the UI acknowledge the copy.
- With lost mode on, both the lost screen and the ICE card show `lost.shown`, so the lost-mode record must carry the ICE fields too.
- Fonts are ASCII only. Names or messages from the app may be Cyrillic: add glyph ranges before showing them.

## Memory and TLS (plan 3)
- Internal heap dips to 62 KB within ~12 s of Wi-Fi bring-up (steady ONLINE minimum 96.9 KB). Measure free heap at every reconnect and set `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` (or the v6.1 equivalent) before adding the TLS/WebSocket channel.

## Open owner checks
- Touch latency on real taps: flash a build with `CONFIG_AELYS_INPUT_SELFTEST=y`, open the emergency card, tap it 20 times; the log prints the median/max.
- Is the amber/red ring centred on the round edge (checks the panel x offset of 6 px)?

## Known limits left as they are
- The two-button hold ring runs at ~48 fps (worst frame 35–42 ms) during the 2 s hold; the rest of the UI holds 60 fps.
- LVGL 9 allocates internally per draw call; the rule is "no app-level allocations per frame".
- Wi-Fi passwords are stored in NVS unencrypted until the owner decides on NVS encryption (spec §4.8, needs an eFuse burn).
- Disconnect reasons 15/204/14 are shown as "Wrong Wi-Fi password" but can also mean a weak signal.
- No WPA3-only (H2E) networks yet.
- Wi-Fi/panel start-failure paths and the queued-Improv-request path compile and were reviewed but were never forced on hardware.
- One unexplained USB-Serial/JTAG silence during measurements (see `budgets.md`); if it recurs, try unplug/replug first and record `lsof /dev/cu.usbmodem*`.
