# Companion firmware: carry-over after plan 1 and plan 3

Backend (plan 2) is done: pairing and login for a `companion` platform, the WebSocket channel, snapshots, actions, owner commands, revoke. Plan 3 (firmware link + app pages) consumes it as listed in "Plan 3 inputs" at the end of this file.

Plan 1 (`docs/superpowers/plans/2026-11-12-companion-firmware-base.md`) is done. These points came out of its reviews and must be picked up later.

## Contracts to change before plan 3 (done in plan 3)
- [x] `UI_EV_OWNER` lifetime: owner data now goes through a triple buffer (`e9cf328`, ui/owner).
- [x] ICE fields in the lost-mode record, so the lost screen and the ICE card agree (`5cb8ffe`, logic/owner + store).
- [x] Cyrillic and Kazakh glyphs in the fonts (`891374e`, ui/fonts).

## Memory and TLS (plan 3)
- [x] mbedTLS buffers allocate in PSRAM (`5a6db3e`, sdkconfig). Still to measure on the board: heap at every TLS connect and the dip after Wi-Fi bring-up (see `link-checklist.md`).

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

## Carry-over after plan 3
Code is done and reviewed, but nothing ran online yet: do `link-checklist.md` first. Then, for plan 4 or later:
- Board is untested online: HTTP/TLS, ws fragment reassembly, close codes, `board_battery`, the Find audio path, brightness QSPI write, and the PWR = top key mapping. Trim the link (8 KB) and ws (6 KB) stacks after a real run. `heap_int_min` was 41 KB offline (below the plan 1 figure): explain it.
- Failed-read tick FIFO can desync (assumes answers arrive in send order): carry the target id in `UI_EV_ACTION`. Two quick Start taps rely on the server's conflict error.
- Unpair, lost mode and re-pair: `ice_update` can save the owner blob but not the lost one (stale ICE on the lost screen after a reboot); unpair writes `reset_revs` before the erase; an identity erase failure then restart is not handled; an unpaired lost board refuses re-pair (owner decision pending).
- Wi-Fi: removing the network in use keeps it connected; a failed `wifi_add` save is invisible to the app; the 20 s "connecting" card is shorter than the 24 s worst case; "Wrong password" is also shown for a weak signal.
- `play_sound` that fails to start is still acked ok; a held finger on a paused Focus can stop the session under the find overlay; the beep call can block the link task.
- Link: a server that sends `ready` and then 4401 loops at login speed (counted as a rejection, only backed off); the link task blocks up to ~18 s in `wifi_add`; AXP2101 is read from two tasks; `lost.on` is read across tasks without a lock.
- Web: an unpaired-then-erased device overview shows "Couldn't reach Aelys" on Back; no backend delete for an orphan approved device after a failed restart; QR picker still lists hidden targets; no focus trap in the reauth sheet.
- Backend (B1): unpair not in the command log; today fields use the Telegram time zone and are not pushed at midnight; a failed send is logged as pending.
- Alembic: B1 uses revision `0051_companion_v11`; plan 4 also creates a `0051_*` and retitles the protocol to v2, so whichever lands second needs one merge revision.
- Spec items still out: OTA, coredump upload, power management, Sounds / Emotions / Other-apps / Name rows, focus break timer, device menu apps, SOS, USB pairing from the Mac app, NVS encryption.
