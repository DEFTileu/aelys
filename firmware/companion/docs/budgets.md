# Firmware budgets (spec §4.6)

Board: Waveshare ESP32-S3-Touch-AMOLED-1.75C, ESP-IDF v6.1, firmware `0.1.0`, release log level WARN.
Runtime figures come from the `metrics` line (`main/metrics.c`): one WARN line per period.

Status: **PASS**, **FAIL** (reported, not tuned away), **PENDING** (needs a measurement not yet taken).

| Budget (§4.6) | Target | Measured | Status | How measured |
|---|---|---|---|---|
| Animations | 60 fps, synced with TE; worst frame <= 25 ms | Idle home only: fps 2.7-5.4, worst frame 15.5-18.9 ms over 10 min (10 s windows) | PENDING | `fps` / `worst_us` from `metrics`. The idle screen redraws rarely, so 60 fps under animation is not measured. Needs the input self-test build (ring animation) or an owner session. |
| Touch -> change on screen | <= 50 ms | not measured | PENDING | Needs the owner's taps. `CONFIG_AELYS_INPUT_SELFTEST` logs `touch -> flush end` per tap. The owner confirmed combo -> ICE -> tap -> home works. |
| Cold start -> clock on screen | <= 1.5 s (no PSRAM memtest) | 6 readings: 1482 ms x4 (cold boots with `--reset`, incl. the re-flash boot), 1481 ms (no-Wi-Fi build), 1529 ms (10 s scratch build, first sample of the 10-minute run). 1 of 6 over 1500 ms. | PASS (marginal: 1 of 6 readings over 1500 ms) | `boot_ms` = end of the first refresh that drew after boot. "Cold" here means a USB-Serial/JTAG chip reset (`rst:0x15`) plus one owner power-cycle; true battery power-on boots are not measured. |
| Free internal heap in ONLINE (minimum) | >= 80 KB | ONLINE steady sampled minimum: 96967 B (60 samples at 10 s over a 10-minute online run, wifi_ip=1). Cumulative `heap_int_min` since boot: 62208 B, reached within ~12 s of Wi-Fi bring-up. | PASS (ONLINE steady sampled minimum; a day-long run not done) | `heap_int` samples from `metrics`. Cumulative `heap_int_min` is reported separately below. |
| App internal RAM without Wi-Fi | <= 100 KB | 78760 B (76.9 KiB) = 322347 B free at `app_main` start minus 243587 B steady free after full init | PASS | No-Wi-Fi scratch build (`CONFIG_AELYS_NO_WIFI=y`, defaults outside the repo, app-only flash). |
| Image size | <= 2 MB | 1 128 770 B (1.08 MB), 73 % of the 4 MB app slot free | PASS | `idf.py size`. |

## Heap risk for plan 3

- Free internal heap timeline, normal build: 263295 B before app init; 97419 B at Wi-Fi start (1.8 s); cumulative minimum 62208 B reached before the first 10 s sample (<= 11.9 s); 96967-97131 B steady from then on.
- The dip is about 35 KB below steady state, within ~12 s of Wi-Fi bring-up. It is recorded as a risk: TLS set up during or right after connect must fit in that margin.
- Likely consumer: the Wi-Fi station connect path (scan and association buffers in the Wi-Fi driver). Hypothesis only: probes inside `net_wifi.c` did not reach the console, so the phase is not attributed.

## Method details

- Free internal at `app_main` start: 263295 B (normal build). 322347 B in the no-Wi-Fi build: the Wi-Fi build reserves about 59 KB before `app_main`, outside the app's own init.
- Stack high-water marks (minimum free stack seen in the 10-min run): `ui` 4928 of 10240 (used 5312 B), `net` 6420 of 8192 (used 1772 B), `input` 2828 of 4096 (used 1268 B). Metrics task (3072 B) not measured.
- The committed default period is 60 s. The 10 s period was used only in scratch builds (10-minute run and no-Wi-Fi run), set from defaults files outside the repo.
- Spec §4.6 reliability says metrics every 5 min; the controller ruling was 60 s.
- Not yet verified: a day-long minimum, touch latency, animation fps.

## Notes

- At the WARN default, the INFO lines `online (network N)` and `offline, retry in ... ms` are hidden. The metrics field `wifi_ip` covers the online state.
- One incident during measurements: the board's USB went silent (no output, esptool sync failed, port still enumerated, display kept running, no core dump). It recovered after an owner power-cycle and has not been reproduced since.
