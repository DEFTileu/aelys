# Firmware budgets (spec §4.6)

Board: Waveshare ESP32-S3-Touch-AMOLED-1.75C, ESP-IDF v6.1, firmware `0.1.0`, release log level WARN.
Runtime figures come from the `metrics` line (`main/metrics.c`): one WARN line per period.

Status: **PASS**, **FAIL** (reported, not tuned away), **PENDING** (needs a measurement not yet taken).

| Budget (§4.6) | Target | Measured | Status | How measured |
|---|---|---|---|---|
| Animations | 60 fps, synced with TE; worst frame <= 25 ms | Idle home only: fps 2.7-5.4, worst frame 15.5-18.9 ms over 10 min (10 s windows) | PENDING | `fps` / `worst_us` from `metrics`. The idle screen redraws rarely, so 60 fps under animation is not measured. Needs the input self-test build (ring animation) or an owner session. |
| Touch -> change on screen | <= 50 ms | not measured | PENDING | Needs the owner's taps. `CONFIG_AELYS_INPUT_SELFTEST` logs `touch -> flush end` per tap. The owner confirmed combo -> ICE -> tap -> home works. |
| Cold start -> clock on screen | <= 1.5 s (no PSRAM memtest) | 1482 ms in 4 cold boots (1482, 1482, 1482 with `--reset`, plus 1482 after the final re-flash) | PASS | `boot_ms` = end of the first refresh that drew after boot. Margin 18 ms. |
| Free internal heap in ONLINE (minimum) | >= 80 KB | `heap_int_min` = 62208 B (61 KiB) as of 10 min. Reached within the first ~12 s after boot, during Wi-Fi bring-up; unchanged for the rest of the 10-min run. | FAIL (reported) | `heap_int_min` from `metrics`. See the note below: the ONLINE steady minimum from the same run is 96967 B. |
| App internal RAM without Wi-Fi | <= 100 KB | 78760 B (76.9 KiB) = 322347 B free at `app_main` start minus 243587 B steady free after full init | PASS | No-Wi-Fi scratch build (`CONFIG_AELYS_NO_WIFI=y`, defaults outside the repo, app-only flash). |
| Image size | <= 2 MB | 1 128 770 B (1.08 MB), 73 % of the 4 MB app slot free | PASS | `idf.py size`. |

## Heap note (for the controller's decision)

- Free internal heap timeline, normal build: 263295 B before app init, 97419 B at Wi-Fi start (1.8 s), dip to 62208 B minimum before the first 10 s sample (<= 11.9 s), then 96967-97131 B for the whole 10-minute online run.
- The minimum is cumulative since boot, so it keeps the dip. Read literally against the budget, the value is 62 KB: FAIL.
- Read as the ONLINE steady state (samples after the connect phase, 10-min run), the minimum is 96967 B (94.7 KiB): would pass.
- The dip is about 35 KB below steady state. Likely consumer: the Wi-Fi station connect path (scan and association buffers in the Wi-Fi driver). Not proven: probes inside `net_wifi.c` did not reach the console (printf and ESP_LOG both), so the exact phase is not attributed. Not tuned here.

## Method details

- Free internal at `app_main` start: 263295 B (normal build). 322347 B in the no-Wi-Fi build: the Wi-Fi build reserves about 59 KB before `app_main`, outside the app's own init.
- Stack high-water marks (minimum free stack seen in the 10-min run): `ui` 4928 of 10240 (used 5312 B), `net` 6420 of 8192 (used 1772 B), `input` 2828 of 4096 (used 1268 B). Metrics task (3072 B) not measured.
- The release build logs at WARN. INFO lines (Wi-Fi driver, netif, board/panel/touch init, input/PMU register dumps, `online` / `offline` net messages) no longer print. `wifi_ip=1` in the metrics line is the online check (IP address on the STA netif).
- The metrics period was 60 s in the committed build and 10 s in the scratch builds used for the 10-minute run and the no-Wi-Fi run (`CONFIG_AELYS_METRICS_PERIOD_S` from a defaults file outside the repo; the committed default stays 60).
- The spec §4.6 reliability line says metrics every 5 min; the controller ruling was 60 s. Used 60 s.
- Not yet verified: the owner's 24 h minimum (the budget as written), touch latency, animation fps.
