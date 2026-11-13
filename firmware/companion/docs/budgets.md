# Firmware budgets (spec §4.6)

Board: Waveshare ESP32-S3-Touch-AMOLED-1.75C, ESP-IDF v6.1, firmware `0.1.0`, release log level WARN.
Runtime figures come from the `metrics` line (`main/metrics.c`): one WARN line per period.

Status: **PASS**, **FAIL** (reported, not tuned away), **PENDING** (needs a measurement not yet taken).

**Latest paired-board checkpoint:** [2026-11-13 measurements](performance-2026-11-13.md).
The historical baseline rows below do not close current acceptance. The latest
310 s baseline reached 38.065 ms per refresh and 51.357 ms post-to-DMA (**FAIL**
against 25/50 ms). A sparse Home/Today redraw experiment reached 44.981/52.869 ms
and remains disabled; its smaller pixel transfer did not establish a board
speed benefit. Different DNS/online histories limit causal comparisons. The
earlier 32 KB probe's minimum since boot was
50472 B, versus 18348 B with 64 KB. A normal 32 KB image is checked separately;
it reported 96095 B free internal heap and 62828 B minimum since boot after
channel establishment (four once-per-minute records). `boot_ms=1774` is a
current **FAIL** against 1500 ms. Day-long online heap and 30-minute reconnect
acceptance remain pending.

| Budget (§4.6) | Target | Measured | Status | How measured |
|---|---|---|---|---|
| Animations | 60 fps, synced with TE; worst frame <= 25 ms | Bouncing-circle bench (display bring-up): 59.9 fps, worst 16.7-16.9 ms. Two-button hold ring: ~48 fps, worst 35-42 ms (accepted for v1). Idle home: fps 2.7-5.4, worst 15.5-18.9 ms | PASS (hold ring excepted) | Bench numbers from the display bring-up; the hold-ring miss is a recorded v1 exception. |
| Touch -> change on screen | <= 50 ms | Owner, 20 real taps on the ICE card (2026-11-13): median 27 ms, max 35 ms | PASS | `CONFIG_AELYS_INPUT_SELFTEST` build: from the I2C read that saw the finger to the end of the flush that drew home. Excludes the touch controller's own report delay. |
| Cold start -> clock on screen | <= 1.5 s (no PSRAM memtest) | 6 earlier readings: 1482 ms x4 (cold boots with `--reset`, incl. the re-flash boot), 1481 ms (no-Wi-Fi build), 1529 ms (10 s scratch build, first sample of the 10-minute run). After `CONFIG_BOOTLOADER_LOG_LEVEL_WARN=y` (bootloader flashed with `idf.py bootloader-flash`): 3 more cold boots with `--reset`, 1482 ms x3. 1 of 9 over 1500 ms. | PASS (marginal: 1 of 9 readings over 1500 ms; the 1529 ms one was a scratch build) | `boot_ms` = end of the first refresh that drew after boot. It is measured from the app's own timer start, so it does not include the ROM and bootloader time; quieting the bootloader log therefore leaves it unchanged at 1482 ms (the saving is before the app starts, not visible in this metric). "Cold" here means a USB-Serial/JTAG chip reset (`rst:0x15`) plus one owner power-cycle; true battery power-on boots are not measured. |
| Free internal heap in ONLINE (minimum) | >= 80 KB | ONLINE steady sampled minimum: 96967 B (60 samples at 10 s over a 10-minute online run, wifi_ip=1). Cumulative `heap_int_min` since boot: 62208 B, reached within ~12 s of Wi-Fi bring-up. | PASS (ONLINE steady sampled minimum; a day-long run not done) | `heap_int` samples from `metrics`. Cumulative `heap_int_min` is reported separately below. |
| App internal RAM without Wi-Fi | <= 100 KB | 78760 B (76.9 KiB) = 322347 B free at `app_main` start minus 243587 B steady free after full init | PASS | No-Wi-Fi scratch build (`CONFIG_AELYS_NO_WIFI=y`, defaults outside the repo, app-only flash). |
| Free internal heap at reconnect | >= 16 KB largest internal block before every TLS connect (the link waits up to 10 s for it); `heap_at_connect_min` and `tls_fail` = 0 over a 30-min chaos run (60 s reconnect) | First real runs (2026-11-13, HEAD b56e97b, 2.4 GHz hotspot, no chaos run yet): 2 TLS connects to production (challenge, check) at `heap_int` 75431-75847 B, `largest` 31744 B (>= 16 KB at every connect); `tls_fail` 0; cumulative `heap_int_min` 36436 B was already reached before the first TLS and did not move after it; steady `heap_int` 75.4 KB after the handshakes (no leak seen). Link task stack: 3436 B free of 8192 after two sign-ins. | PARTIAL (30-min chaos run still PENDING; steady `heap_int` 75.4 KB is below the 80 KB ONLINE budget with the link, F8 and F9 in the image) | `link connect heap_int=... largest=...` WARN line before every TLS connect; metrics `heap_at_connect_min`, `tls_fail`, `hwm_link`, `hwm_ws`. Scratch build with `CONFIG_AELYS_LINK_CHAOS_S=60` and `CONFIG_AELYS_METRICS_PERIOD_S=10`. |
| Image size | <= 2 MB | 1 541 210 B (1.47 MB) with the new face: +8 712 B over the 1 532 498 B of the same tree before it (face code and A8 shapes +9.1 KB, the six unused bold "!?z" fonts gone). The 2026-11-13 reading was 1 446 982 B before the link and websocket client. | PASS | `idf.py size`. |
| Face motion cost (new gradient-eye face) | idle home 60 fps budget unchanged; worst frame <= 25 ms with the face animating, also while a TLS reconnect runs | Host sim only so far: a face at rest redraws nothing (calm holds still for 2.5 s of its look loop, a hidden face never draws); a moving face only invalidates its own box plus 30 px of overhang, for every mood over 12 s (`test_face_moods`). On the board PENDING (Task F1 step 5: the board was unavailable) | PENDING | Board: `metrics` fps and worst frame on home for 5 minutes, and frame times during a reconnect. |
| Touch -> swipe changes screen (Today / Aelys / Focus) | <= 50 ms | PENDING: Task F8 board step (the board was unavailable) | PENDING | Same method as the ICE tap row; a swipe fires at the lift. |
| Idle fps with the companion screens | unchanged from idle home | Host sim: Today and Inbox draw nothing between snapshots (`test_idle_screens_do_not_redraw`); on the board PENDING | PENDING | `metrics` fps on Today, Focus and Aelys. |

## Heap risk for plan 3

- Free internal heap timeline, normal build: 263295 B before app init; 97419 B at Wi-Fi start (1.8 s); cumulative minimum 62208 B reached before the first 10 s sample (<= 11.9 s); 96967-97131 B steady from then on.
- The dip is about 35 KB below steady state, within ~12 s of Wi-Fi bring-up. It is recorded as a risk: TLS set up during or right after connect must fit in that margin.
- Likely consumer: the Wi-Fi station connect path (scan and association buffers in the Wi-Fi driver). Hypothesis only: probes inside `net_wifi.c` did not reach the console, so the phase is not attributed.

## Method details

- Free internal at `app_main` start: 263295 B (normal build). 322347 B in the no-Wi-Fi build: the Wi-Fi build reserves about 59 KB before `app_main`, outside the app's own init.
- Stack high-water marks (minimum free stack seen in the 10-min run): `ui` 4928 of 10240 (used 5312 B), `net` 6420 of 8192 (used 1772 B), `input` 2828 of 4096 (used 1268 B). Metrics task (3072 B) not measured.
- The committed default period is 60 s. The 10 s period was used only in scratch builds (10-minute run and no-Wi-Fi run), set from defaults files outside the repo.
- Spec §4.6 reliability says metrics every 5 min; the controller ruling was 60 s.
- Not yet verified: a day-long heap minimum.

## Notes

- At the WARN default, the INFO lines `online (network N)` and `offline, retry in ... ms` are hidden. The metrics field `wifi_ip` covers the online state.
- One incident during measurements: the board's USB went silent (no output, esptool sync failed, port still enumerated, display kept running, no core dump). It recovered after an owner power-cycle and has not been reproduced since.

## Continuation checkpoint (2026-11-13, host changes only)

- Task P1: periodic and snapshot rendering now updates only the visible Home / Today / Focus / Inbox screen. Entry refreshes it from the current snapshot and clock before its first frame; a hidden Focus does not update its countdown labels or layout. Host regressions cover elapsed time on return, paused-key actions, and snapshots arriving under the ICE card. This removes redundant work; ESP32 frame-time and heap improvements are **not yet measured**.
- Task F1 review fixes: a face hidden for more than nine days resumes its animation, including across the 32-bit millisecond clock wrap. Pixel-exact redraw coverage now checks every 5 ms over 12 s for all 14 moods; removing a burst-line invalidation was detected at 630 ms (112 differing pixels). The oracle restores the partial framebuffer after each comparison so it cannot repair stale pixels for the next check.
- Validation: `cmake -S sim -B sim/build && cmake --build sim/build -j 8 && ctest --test-dir sim/build --output-on-failure` passed 19/19 tests (10.97 s); `idf.py build size` passed with `CONFIG_AELYS_PERF_PROBE` off, image 1541262 B (under 2 MB); `git diff --check` passed. This is host/build evidence only.
- Exploratory desktop benchmark: 10,000 same-state snapshot events using real simulator/LVGL code, comparing `b74e72c` screen logic with the change. Home: 3.06 → 0.03 µs/event; ICE: 2.24 → 0.02 µs/event. These are synthetic host timings, not board fps or input latency.
- Read-only board capture after a reset: `paired=1`; initial sign-in attempts returned DNS error `0x8001` (before a TLS handshake). A later sample at app time 122205 ms reported `wifi_ip=1`, free internal heap 63815 B, cumulative minimum 30548 B, largest block 31744 B, fps 5.1, worst refresh 16141 µs, `boot_ms=1757`, `heap_at_connect_min=75607`, `tls_fail=0`, `hwm_ws=0`. No further sign-in error appeared in that capture window. Wi-Fi connectivity alone does not confirm the WebSocket state. These figures describe the **previously flashed image**, not the new face or these host changes, and do not satisfy the ONLINE heap or new-face acceptance gates.
- No application was flashed, and no sound, account action, Wi-Fi setting, pairing or NVS state was changed. The inherited seven-file `CONFIG_AELYS_PERF_PROBE` harness remains uncommitted and was not used for these readings. Cause of the earlier 22672 B heap minimum, new-face performance, online/TLS frame times, synthetic swipe latency and the memory-tuning experiments remain **PENDING**. Do not begin app/menu work based on these host timings.

## Character v2 larger Home face (host only)

The Home face box is now 390×221 px (130% of 300×170); the 70×100 px
calm eyes become approximately 91×130 px. The clock and agenda remain in the
centred stack, and the Wi-Fi line moves down on the welcome layout to clear its
two-line hint. The host suite checks circular clipping and layout; these are not
measurements of the device.

A same-tree simulator comparison changed only Home face scale. With the
**disabled-by-default** sparse-screen-switch experiment enabled, the fixed
Home/Today navigation fixture transferred 154692–156980 pixels per switch at
100%, versus 178584–183844 at 130%; one full display is 217156 pixels. This
confirms increased host transfer area, not device latency, fps or causation of
any board-frame failure. The host traffic regression guard now requires a switch
below 7/8 of a full screen instead of 3/4; pixel-exact redraw checks remain.
Sparse switching stays disabled because the prior board experiment did not
establish a benefit. Frame rate, swipe latency, `heap_int` and `heap_int_min`
with the enlarged face remain **PENDING board**.
