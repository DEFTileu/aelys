# Firmware budgets (spec §4.6)

Board: Waveshare ESP32-S3-Touch-AMOLED-1.75C, ESP-IDF v6.1, firmware `0.1.0`, release log level WARN.
Runtime figures come from the `metrics` line (one WARN line per period, see `main/metrics.c`).

Status: **PASS**, **FAIL** (reported, not tuned away), **PENDING** (needs a measurement not yet taken).

| Budget (§4.6) | Target | Measured | Status | How measured |
|---|---|---|---|---|
| Animations | 60 fps, synced with TE; worst frame <= 25 ms | Idle home: 5.1 fps, worst frame 17.6 ms (window ending at 60 s after boot) | PENDING | fps and worst frame from `metrics`. The idle screen draws rarely, so fps under animation is not measured yet. |
| Touch -> change on screen | <= 50 ms | not measured | PENDING | Needs the owner's taps. `CONFIG_AELYS_INPUT_SELFTEST` logs `touch -> flush end` per tap. |
| Cold start -> clock on screen | <= 1.5 s (no PSRAM memtest) | 1482 ms (run 1 of 3) | PASS (provisional) | `boot_ms` = first refresh that drew after boot, from `metrics`. Runs 2 and 3 pending. |
| Free internal heap in ONLINE (minimum) | >= 80 KB | `heap_int_min` = 62208 B, Wi-Fi up, measured since boot (60 s) | FAIL (provisional) | `heap_int_min` from `metrics`. The minimum over a day cannot be measured in one session; the 10-minute run is pending. |
| App internal RAM without Wi-Fi | <= 100 KB | not measured | PENDING | Build with `CONFIG_AELYS_NO_WIFI=y` from a defaults file outside the repo. Method: free internal at `app_main` start minus `heap_int` after init. |
| Image size | <= 2 MB | 1 128 770 B (1.08 MB), 73 % of the 4 MB app slot free | PASS | `idf.py size`. |

## Method details

- Free internal at `app_main` start: 263295 B (line `psram_size=... free_internal=...`).
- Free internal with Wi-Fi at 60 s after boot: 97095 B. Heap usage by Wi-Fi and init is therefore about 166 KB; the no-Wi-Fi build gives the app-only figure.
- Stack high-water marks at 60 s (free bytes at the deepest point so far): `ui` 5104 of 10240, `net` 6420 of 8192, `input` 2892 of 4096. These are the minimum free stack seen so far; re-check after the 10-minute run.
- The release build logs at WARN. INFO lines (Wi-Fi driver, netif, board/panel/touch init, input/PMU register dumps, `online` / `offline` net messages) no longer print.
- `wifi_ip=1` in the metrics line is the online check (IP address on the STA netif) while INFO logs are off.
