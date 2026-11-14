# Firmware budgets (spec §4.6)

## Paired-board continuation (2026-11-14)

Measured on S1 `5af7fa4` with physical sound disabled. The owner-authorized
app-only flashes were hash-verified; no Wi-Fi configuration was changed.
The ordinary 64 KiB cache build (`f17cac4`, probe and chaos off) reported
`heap_int=64747` and `heap_int_min=31488` bytes in each of five minute samples;
the device was shown Online in Aelys. The steady free-heap target of 80 KB
therefore **FAILS** for this configuration and observation window.

A 310-second, instrumented 64 KiB cache run had 289 complete numerical samples,
233 of them Online. Online free heap was 51871–52403 bytes; the minimum since
boot was 18880 bytes. Its cumulative worst refresh was 52401 µs and maximum
synthetic screen-switch latency was 55767 µs across 157 successful switches:
the 25 ms refresh and 50 ms switch budgets both **FAIL**. No queue/transfer
failures were reported; `tls_fail` was zero in all 31 complete metrics lines.
The probe adds overhead, forces a reconnect every 60 seconds, and includes
startup and screen transitions in cumulative maxima; incomplete serial lines
were excluded. The figures do not establish sustained face FPS.

A similarly instrumented 32 KiB cache run had 309 samples, all without Wi-Fi
or Online status. Free heap was 96559–96631 bytes, minimum since boot 56736;
worst refresh was 47632 µs and maximum synthetic switch latency 51744 µs
across 158 successful switches. Both timing budgets **FAIL** in that run.
Because network conditions differ, the two runs do not establish a causal
cache-size improvement or comparable Online heap. The earlier 32 KiB Online
measurements remain historical; a day-long heap measurement remains
**PENDING**. Afterward, an ordinary 32 KiB build with probe,
chaos and physical sound off was app-flashed and hash-verified; Aelys displayed
the companion Online. Its three minute samples each reported `heap_int=96739`
and `heap_int_min=63476` bytes (`wifi_ip=1`, `tls_fail=0`). This is a short
checkpoint rather than day-long acceptance; the ordinary 64 and 32 KiB samples
were taken at different times and on adjacent commits. A subsequent 310-second
probe32 repetition captured 286 complete samples, 222 Online. Online heap was
84147–84339 bytes and the boot minimum was 50912 bytes. Its cumulative worst
refresh was 51017 µs and its maximum synthetic switch was 55546 µs across 156
successful switches; both timing budgets still **FAIL**. No queue or transfer
failures were reported, and `tls_fail` was zero in 31 complete metrics lines.
Different connection histories and natural workload variation limit causal
comparisons. A separate 65-second task sample placed UI on core 1 and link and
input on core 0; tcpip was unpinned. In six roughly 10-second intervals, UI
runtime was 0.434–0.633 seconds; these averages do not explain worst-frame
latency. The task affinity field does not establish where unpinned tasks ran.
A follow-up 130-second attribution probe on `d688d04` recorded 120 complete
samples, 109 Online. Its worst frame was 39640 µs on Today. The longest of
69 synthetic switches was 49221 µs, also to Today: 14509 µs queued, 36 µs
waiting for refresh, and 34676 µs in the frame, including 12806 µs waiting for
TE. The separately observed maximum non-TE frame time was 27356 µs on Today.
These are maxima from one short run, not proof of a root cause; added probe
logging and different network conditions affect comparisons. Sanitized samples
and the summary script are in the local S1 ledger, not in the repository.

A subsequent selective-IRAM experiment moved five arc-path functions to IRAM:
static DIRAM grew by 6104 bytes, from 163642 to 169746. Its 310-second run
captured 309 samples, all Offline, so no Online memory or latency conclusion is
available. Compared with the earlier Offline probe32 run, each had 150 switches
in five complete histogram windows: p50 was [30,35) ms, p90 [45,50) ms and
p99 [50,55) ms for both. The observed worst frame fell from 47632 to 36338 µs,
but TE wait on those worst frames also differed (43648 versus 14513 µs), so
the difference does not establish a speedup. With no clear switch improvement
and additional internal-memory cost, the experiment was removed. These are
short, separate runs and do not isolate all workload variability.

A separate 130-second display-I/O attribution run on `c7e4f19` had 130
complete samples, all Offline. Its slowest of 69 successful switches took
51811 µs: 15695 µs queued, 35 µs before refresh, and 36081 µs for the
frame, including 13574 µs TE wait. That frame submitted 217156 pixels in 15
flushes; the UI task spent 2287 µs in submission calls and 3640 µs waiting
on the completion semaphore. These are elapsed task times, which can include
scheduling delays and do not measure total DMA duration. The remaining frame
time includes drawing and instrumentation; it is not a direct CPU profile.
The extra timing calls affect this short probe, and Offline results must not be
compared as if the network workload were identical.

An experimental 22-region sparse redraw (`5403d57`) passed the host
partial-vs-full framebuffer regression. An exhaustive comparison of the old
30 ring rectangles with the 22 replacements found no uncovered pixels; the
new set adds 3556 pixels. In roughly 320 seconds on the board it produced 306
complete samples, 99 Online, and 174 successful switches; worst frame was
42062 µs and worst switch 52736 µs, so both absolute budgets **FAIL**. Five
complete histogram windows containing 149 switches gave p50 [25,30) ms,
p90 [35,40) ms and p99 [50,55) ms. No queue or transfer failures were reported.

A subsequent 310-second full-redraw control used the same branch, profiler,
32 KiB cache and reconnect settings; its configuration differed only in the
sparse flag. It had 310 complete samples, all Offline, and 163 successful
switches; worst frame was 36710 µs and worst switch 52250 µs. Five complete
windows with 150 switches gave p50 [35,40) ms, p90 [45,50) ms and p99
[50,55) ms. In the first 60-second window of each run, when both were Offline,
sparse p50/p90 were [20,25)/[30,35) ms versus [30,35)/[45,50) ms for full
redraw (30 switches each). Network availability, snapshots and animation
phases differed across runs, so these observations do not establish an Online
speedup. The sparse experiment stays disabled by default pending matched
Online testing, and does not close S1's performance gates. The board was
returned to the normal sound/probe/chaos/sparse-off app and hash verified.

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
