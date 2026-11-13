# Companion firmware: carry-over after plan 1

Backend (plan 2) is done: pairing and login for a `companion` platform, the WebSocket channel, snapshots, actions, owner commands, revoke. Plan 3 (firmware link + app pages) consumes it as listed in "Plan 3 inputs" at the end of this file.

Plan 1 (`docs/superpowers/plans/2026-11-12-companion-firmware-base.md`) is done. These points came out of its reviews and must be picked up later.

## Contracts to change before plan 3
- `UI_EV_OWNER` carries a pointer to a sender buffer. Today the only sender is synchronous at boot. Once data arrives from the app, the buffer must stay unchanged until the UI has copied it: double-buffer in the sender or have the UI acknowledge the copy.
- With lost mode on, both the lost screen and the ICE card show `lost.shown`, so the lost-mode record must carry the ICE fields too.
- Fonts are ASCII only. Names or messages from the app may be Cyrillic: add glyph ranges before showing them.

## Memory and TLS (plan 3)
- Internal heap dips to 62 KB within ~12 s of Wi-Fi bring-up (steady ONLINE minimum 96.9 KB). Measure free heap at every reconnect and set `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` (or the v6.1 equivalent) before adding the TLS/WebSocket channel.

## Owner checks (done 2026-11-13)
- Touch latency on real taps: median 27 ms, max 35 ms (budget 50 ms).
- Ring centred on the round edge: OK, so the panel x offset of 6 px is right.

## Known limits left as they are
- The two-button hold ring runs at ~48 fps (worst frame 35–42 ms) during the 2 s hold; the rest of the UI holds 60 fps.
- LVGL 9 allocates internally per draw call; the rule is "no app-level allocations per frame".
- Wi-Fi passwords are stored in NVS unencrypted until the owner decides on NVS encryption (spec §4.8, needs an eFuse burn).
- Disconnect reasons 15/204/14 are shown as "Wrong Wi-Fi password" but can also mean a weak signal.
- No WPA3-only (H2E) networks yet.
- Wi-Fi/panel start-failure paths and the queued-Improv-request path compile and were reviewed but were never forced on hardware.
- One unexplained USB-Serial/JTAG silence during measurements (see `budgets.md`); if it recurs, try unplug/replug first and record `lsof /dev/cu.usbmodem*`.

## Plan 3 inputs (backend done, 2026-11-13)
- Protocol: `docs/companion-protocol.md` is the contract; HTTP routes and auth model are in `docs/API_CONTRACTS.md` (section "Companion").
- Routes: pair with `platform: "companion"`, log in by device signature (no refresh token, so log in again when the access token expires); channel `/api/v1/devices/channel` with the `Authorization` header only; owner routes under `/api/v1/companion/devices/{id}/...`.
- `rev` rules: `lost_mode` and `ice_update` carry a per-device, per-name `rev`. Apply a command only if its `rev` is greater than the last applied one for that name, always ack (a stale one too), keep the last `rev` in NVS. `BUSY` keeps the command pending until the next `hello`. Delivery is at-least-once, so the same `id` can come again.
- Reconnect: on close `1011` (server-side send/channel failure) back off and reconnect; a fresh snapshot follows. Never reconnect immediately in a loop.
- Close codes: `4401` re-login then reconnect; `4403` re-check with `/auth/device/challenge` and wipe pairing only if it says the device is unknown or revoked (401 `UNAUTHORIZED`); `4000` do not reconnect, a newer connection is live.
- Action ids: the server requires a UUID v4 per action and treats a repeated `id` as the same action (stored result, no second effect). Reuse the id only when resending the same action after a lost reply; generate a fresh id when the user retries.
- Commands never queued (`play_sound`, `wifi_add`, `wifi_scan`) arrive only while online; `wifi_scan` is answered by `wifi_scan_result`, not `command_ack`.
- Send `hello` after `ready`/`snapshot`; pending commands are delivered after it. Frames are text only, at most 4 KB.
