# Paired-board performance — 2026-11-13

P1 measurement slice, Waveshare ESP32-S3-Touch-AMOLED-1.75C. Firmware sources:
`c971f29` (new face, visible-screen rendering and silent probe). Only the data
cache size differs between the two probe configurations. The proposed normal
default is 32 KB, based on the recovered internal RAM below. The normal run is
recorded separately; full hardware acceptance is not inferred from the build
or host tests.

## Method

All images were built from fresh local `main` (`c971f29`), using separate
scratch configurations outside Git, flashed with **app-flash only** at
`0x20000`, and hash-verified. Pairing, NVS and saved Wi-Fi were preserved. No
Find/audio/task/focus/notification action test, re-pair, network provisioning, erase or eFuse
operation was performed. Logs and firmware images stay outside Git; this report
contains aggregate numeric diagnostics only.

The original image was observed for 305 s without resetting it. Each new probe
image was captured from a reset for 310 s, with local Home/Today changes every
2 s and forced channel reconnects after 60 s online. Probe results include TE
wait and the final successful DMA completion; failed transfers have separate
counters. Published snapshots are cumulative and coherent; omitted publications
are counted. The normal production display metric has its earlier LVGL event
boundary, so **its frame times are not directly comparable to the probe**.

Both probe runs contain intermittent DNS failures; the 64 KB run spends more
time offline. Snapshots and mood selection therefore differ. The results show
representative workloads, not a controlled claim that 32 KB makes rendering
faster. The histogram is 5 ms wide and excludes failed/interrupted samples.

## Results

| Metric | Original image, normal | New face + probe, 64 KB cache | Same probe, 32 KB cache |
|---|---:|---:|---:|
| Duration | 305 s | 310 s | 310 s |
| Full normal-metric records | 5 | 30 | 30 |
| Online published probe records | unavailable | 141 | 239 |
| Free internal heap, online probe samples | not independently confirmed online; 63543 B with Wi-Fi IP | 51487–51651 B | 83731–83787 B |
| Minimum sampled free internal heap, all probe states | unavailable | 51267 B | 83391 B |
| Minimum free internal heap since boot | 23028 B (existing boot history) | 18348 B | 50472 B |
| Largest internal block before each logged TLS connect | 31744 B | 31744 B | 31744 B |
| Successful local screen changes | not injected | 152 | 152 |
| Queue drops / refused / timeouts / interrupted | not injected | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Failed frames / failed measured transfers | not instrumented | 0 / 0 | 0 / 0 |
| Screen-change maximum, post → final DMA | not instrumented | 51777 µs | 50109 µs |
| Screen-change P50, histogram bin | unavailable | [25, 30) ms | [25, 30) ms |
| Screen-change P90, histogram bin | unavailable | [40, 45) ms | [35, 40) ms |
| Completed histogram samples | unavailable | 149 | 149 |
| Maximum full refresh, including boot/screen changes | 19642 µs, earlier metric boundary | 39792 µs | 40390 µs |
| Maximum refresh work excluding its TE wait | unavailable | 26115 µs | 29212 µs |
| Frames over 25 ms / total counted frames | unavailable | 114 / 4436 | 121 / 2114 |
| Peak ~1 s refresh-count rate | unavailable | 59.8 fps | 59.8 fps |
| Snapshot event maximum | unavailable | 1996 µs | 1345 µs |
| Live WS stack minimum, final record | 2088 B, earlier method | 2004 B | 2000 B |
| Link stack minimum | 3120 B | 3128 B | 3124 B |
| Forced reconnects | 0 | 2 | 4 |
| DNS failures | 0 during capture | 7 | 6 |
| TLS-failure counter / panics | 0 / 0 | 0 / 0 | 0 / 0 |

The histogram omits the first few samples before its first baseline and the
partial final window; the exact maximum uses all 152 successful samples.

## Findings and limits

- The observed all-state sampled minimum and boot minimum are each **32124 B**
  higher with the 32 KB cache than in the otherwise identical instrumented build.
  ESP-IDF's ESP32-S3 memory layout makes a further 32 KB DRAM region available
  when the cache is <=32 KB. The 644 B gap between the nominal region and the
  difference of cross-run minima is consistent with overhead, but this experiment
  does not isolate its exact cause. This is observed recovery, not a stack-size
  estimate. No Wi-Fi buffer or task-stack reduction is included.
- In the 64 KB probe, the boot minimum is already 24184 B before the first
  challenge/TLS connect. It drops further to 19196 B during WS establishment,
  then to 18348 B. Thus the shortage begins before the first handshake and WS
  establishment adds pressure. This does **not** uniquely attribute the old
  23028 B minimum to one allocation; exact allocation attribution still needs a
  heap trace. mbedTLS and LVGL already allocate their bulk buffers in PSRAM.
- Runtime snapshots show the UI on core 1, priority 6, link/WS on core 0,
  priority 5, and `tcpip` priority 18 with no affinity. Both cores spend most
  measured intervals idle. This is no evidence that TLS CPU saturation causes
  the reported slowness, and does not identify the core executing an unpinned
  task. Priority/affinity remain unchanged.
- Slow refreshes occur mainly in intervals containing screen changes. Home and
  Today roots cover the panel; showing/hiding them invalidates a large area.
  Full-refresh work itself exceeds 25 ms in both configurations; changing CPU
  priorities or removing TE synchronization is not an established remedy.
- **Frame budget FAIL:** the 25 ms worst-frame requirement is not met. Peak
  59.8 fps is not sustained 60 fps acceptance. **Screen latency FAIL:** the
  measured maxima slightly exceed 50 ms in both probe runs. Median/P90 do not
  replace the worst-case requirement.
- Online means published link state `LS_ONLINE` (4), not only Wi-Fi IP. The
  lowest 32 KB online sample is 83731 B, only 1811 B above 80 KiB with the probe,
  but this is a five-minute observation, not the specified day-long minimum.
  The probe adds static state, a 4096 B task stack, tracing and logging overhead;
  accept the normal-build heap separately.
- No task stacks are trimmed: the live WS minimum is about 2 KB and the link
  about 3.1 KB, but Wi-Fi command/error/audio paths were not all exercised here.
  Wi-Fi buffer tuning and LVGL IRAM placement remain deferred. The cache change
  recovers memory without those additional risk/CPU tradeoffs.

## Remaining acceptance

Day-long heap minimum; 30-minute reconnect chaos; actual finger-to-display
latency, gestures under queue pressure, DMA/TE fault injection; attribution of
individual slow frames and the pre-TLS allocation peak. Menus/apps remain plan 5
work pending owner scope agreement; these results do not authorize voice.

## Normal image, 32 KB cache (305 s)

The normal fresh-main image has `AELYS_LINK_CHAOS_S=0` and no performance probe.
Its image size is 1541262 B. It was app-flashed and hash-verified after the two
probe runs, then captured from a reset for 305 s. The `paired=1` boot message and
the owner's app overview confirmed the companion remained paired and **Online**.
No task/focus/notification action was triggered by the agent.

The first minute had six DNS failures; subsequent challenge/login/WS setup
completed. The minute-2 through minute-5 records each reported 96095 B free
internal heap, cumulative minimum 62828 B, largest block 31744 B, `tls_fail=0`
and WS stack minimum 2084 B. The first, pre-channel record had 108215 B free.
The final UI stack watermark was 4640 B; link 3132 B. No panic, disconnect/error
after that establishment, or forced reconnect was recorded during the capture.

The five normal metric records showed worst refreshes between 16232 and
22378 µs and update rates between 4.7 and 54.5 fps. These are samples of the
existing rolling five-second windows at one-minute intervals, with the earlier
LVGL completion boundary; they are **not** an exhaustive worst-frame check over
305 s or proof of sustained 60 fps. Calm and offline moods have different
motion/rest patterns, so low idle update counts are not dropped-frame counts.
`boot_ms=1774` exceeds the 1500 ms target (**FAIL**, app-start-to-first-refresh
metric only, not full battery power-on timing).

The 32 KB default is retained for the measured memory gain. Frame/screen latency
failures remain explicitly open; no Wi-Fi buffer, task affinity/priority, task
stack or LVGL IRAM change is bundled with it. The board was left on a normal
image, without diagnostic screen switching or forced reconnects.

## Saved-network comparison (owner authorized)

After the normal 305 s capture, the owner explicitly allowed switching between
the two saved, enabled Wi-Fi networks. In the existing Mac app, the second
profile was moved to first priority, then the board was reset without changing
credentials or deleting either profile. The app overview confirmed **Online**
on the second network; both profiles remained saved. The second profile remains
first priority.

A 125 s capture on that network reported no DNS/TLS failure or panic, with two
normal metric records: internal heap 95867 B, boot minimum 62620 B, largest block
31744 B, WS watermark 2092 B and link watermark 3172 B. Their worst sampled
refreshes were 13554 and 21615 µs; `boot_ms=1790` still fails the startup budget.
The earlier normal run had six initial DNS failures before recovering on the
first network. This short comparison supports leaving the working second
network preferred; it does not isolate the DNS cause or prove long-term network
reliability. SSIDs and passwords are intentionally absent from this report.

## Validation and handoff

The normal and probe images built successfully with ESP-IDF, and the generated
32 KB/64 KB probe configurations differ only in the cache selection and its
derived size. The 20 host tests pass (9.37 s), `git diff --check` passes, and an
independent review found no material config/report issue. These checks do not
replace the remaining hardware gates above. Push/deployment and OTA/power work
are outside this slice; no irreversible board operation was performed.
