# P1 measurement probe audit — 2026-11-13

Scope: the seven-file `CONFIG_AELYS_PERF_PROBE` prototype left in
`feat/companion-face-perf`, and its P1 replacement. The original findings below
are retained as the audit record. The replacement is host-tested and builds in
both configurations; **board validation remains pending**. The probe defaults
off and no device setting or production memory/cache/stack budget has changed.

## Original findings before a board run

| Finding | Source | Required correction / verification |
|---|---|---|
| UI counters are copied and zeroed by the metrics task while the UI task updates them. The result can combine different frames or lose the worst frame. `volatile` does not make the structure transfer coherent. | `components/board/lv_port.c`, `lv_port_probe_take()` | UI owns collection and window rollover. Publish immutable windows through a bounded single-writer/single-reader transfer; record overruns explicitly. Stress the transfer with the host concurrency tests before relying on maximum values. |
| CPU sample tables are copied and cleared while tick hooks on both cores mutate them. | `main/metrics.c`, `pr_tick()` / `pr_cpu_report()` | Use coherent per-core publication; verify callback/ISR safety and quantify sampling overhead. Report missing samples and a full task table rather than silently discarding them. |
| Input reads the screen on another task, then queues TOUCH, SWIPE and RELEASE separately. The screen can change between those operations; queue exhaustion can drop RELEASE. A synthetic TOUCH reaching paused Focus can arm the real stop action. The claimed “no action can be sent” guarantee is therefore unverified. | `components/board/board_input.c`, `probe_swipe()`; `components/ui/screens.c`, `UI_EV_TOUCH` | Use a dedicated probe request, validated and handled entirely on the UI task. It must never enter action/hold handlers. Tests must cover screen changes, lost/ICE/Find overlays, real concurrent input and queue saturation with **zero account actions**. |
| Swipe timestamps are three independent cross-task reads; completion can be attributed to a different refresh. Timeout is represented as `1` µs. | `components/board/board_input.c`, `probe_swipe()` / `board_probe_swipe()` | Associate each request with its handled event and first completed matching frame. Publish a coherent result with explicit timeout/drop status. Exclude failures from latency percentiles and report their count. Test clock rollover. |
| `link_probe_state()` and `pr_cur_screen()` read task-owned mutable state directly from the metrics task. | `components/link/link.c`; `main/metrics.c` | Publish synchronized diagnostic state; do not use unprotected UI/FSM reads as evidence of ONLINE. |
| Probe code requires FreeRTOS trace/runtime statistics and the optional `TaskStatus_t.xCoreID`, but its Kconfig option does not declare those prerequisites. | `main/Kconfig.projbuild`; `main/metrics.c` | Make configuration requirements explicit and validate both a fresh normal configuration and a fresh probe configuration. The previous scratch defaults are not proof that enabling the option alone builds. |
| The local heap-minimum monitor changes what the shared minimum-heap API reports, while ordinary metrics still label the result as `heap_int_min`. The probe also adds a task/stack and static arrays. | `main/metrics.c`, `probe_task()` / `metrics_start()` | Keep boot and window minima distinct. Report instrumentation RAM/CPU cost. Compare old/new UI with identical instrumentation and configuration; do not compare a normal baseline to an instrumented candidate. |
| `hwm_ws` is sampled only during socket teardown. A healthy persistent connection can report zero indefinitely. | `components/link/link_ws.c`, `link_ws_close()` | Sample the watermark from the live WebSocket task and publish it safely. Verify it during a real handshake/connected session before choosing a smaller stack. |

## Memory experiments: measured gain and cost still pending

Change one variable at a time after a repeatable baseline exists. Keep the same
Wi-Fi network, display workload, reconnect schedule and probe configuration.
Record steady/minimum free internal heap, largest block before every TLS connect,
frame histogram, swipe failures/latency, TLS errors and stack watermarks.

| Lever | Current evidence | What must be measured before retaining a change |
|---|---|---|
| mbedTLS external allocation | Already enabled in `sdkconfig.defaults`; LVGL allocation already uses PSRAM. | Allocation peaks during HTTPS login and WSS handshake; configuration alone does not attribute the earlier 22672 B minimum. |
| Data cache 64 → 32 KB | Current default is 64 KB; no comparative board run. | Actual internal-heap gain against rendering/TLS/PSRAM access cost. A nominal cache-size difference is not measured free heap. |
| Wi-Fi/lwIP buffers | No accepted reduction from a paired-board comparison. | Heap gain, reconnect robustness and transport throughput under the same workload. |
| Task stacks | Earlier observations exist, but the WebSocket live watermark is missing. | Deepest TLS, reconnect, error and input/audio paths relevant to each task; retain safety margin rather than trimming from an idle sample. No audible test without owner consent. |
| LVGL fast functions in IRAM | No comparative board evidence. | Frame-time improvement versus internal RAM consumed; confirm the exact linked placement and inspect image size. |
| `tcpip` core affinity | Current configured priority 18, no affinity; UI priority 6 on core 1, link/WS priority 5 on core 0. | Per-core execution and actual overlap with slow frames. Do not change affinity/priority solely from these static settings. |

## Integration and measurement order

1. Finish review and host validation of the committed pairing/face/screen branch.
   Keep the unfinished probe out of that commit set.
2. Obtain the owner's explicit approval before merging to `main`, as required by
   `HANDOFF.md`. Pushing and deployment are separate approvals. Do not touch the
   owner's unrelated changes in the main checkout.
3. Fix and validate the probe in the isolated P1 worktree. Integrate the reviewed
   probe only with the owner's approval; build anything intended for the owner's
   board from fresh `main`, per `HANDOFF.md`.
4. Capture comparable 5–10 minute paired-board baselines/candidates with silent
   app-only updates, keeping pairing/NVS/Wi-Fi intact. Establish channel state;
   `wifi_ip=1` by itself is insufficient. Include snapshots and reconnects.
5. Record the measurements in `budgets.md`, including failures. Leave new-face
   board acceptance, memory tuning and plan 5 scope open until the evidence exists.

## Validation of the separate face branch

Whole-branch review found style slots first allocated on mood entry/animation.
The fix reserves box geometry, image positions/opacity and eye border colour at
creation. A regression observed growth for 11 moods before the fix; after it,
local style counts stay constant on mood entry and every 5 ms over 12 s for each
of the 14 moods. This checks application style storage, not framework draw-time
allocations or the final board RAM cost.

Fresh host verification passed:

- `cmake -S sim -B sim/build && cmake --build sim/build -j 8 && ctest --test-dir sim/build --output-on-failure`: 19/19 tests, 12.59 s.
- `python3 tools/gen_face_fx.py | cmp - components/ui/img_fx.c`: identical generated output; image data unchanged.
- `git diff --check`: no whitespace errors in the working changes.

No firmware was built for the owner's board in this continuation: that follows
the approved integration into fresh `main`. The 1541262 B image figure in the
earlier `budgets.md` checkpoint belongs to `2597b72`, before this style fix.
The seven-file prototype was excluded from those face changes and host claims.

## P1 replacement and verification

- The UI task now owns all frame/input counters and publishes cumulative snapshots
  through the existing C11 triple buffer. The metrics reader never clears a UI
  structure. Sequence gaps are reported; cumulative maxima and failures survive
  skipped publications. A 100000-publication two-thread host test checks coherence.
- Input posts one internal diagnostic event, without TOUCH/TAP/RELEASE. The UI
  callback can only switch Home/Today, refuses lost/ICE/Find/Focus/Inbox/pairing
  and real touch/combo activity, and cannot call an account action. A physical
  input flag also blocks requests while real events await queue space; a dropped
  request is counted. A movement cancellation is distinguished from physical lift
  in the optional RELEASE payload. Queue pressure on actual FreeRTOS/hardware is
  still an acceptance check, not claimed from the host UI tests.
- Requests older than one second are rejected before calling the UI callback.
  Refusal, interrupted measurement, timeout, queue drop and transfer failure have
  separate counters; only successful samples enter the 5 ms histogram (bin 20 is
  >=100 ms). Unsigned-clock wrap, late frames, failures and skipped publications
  have pure-C regression coverage.
- Probe builds wait for the last display DMA before counting a successful frame;
  failed submissions/timeouts are excluded. This wait changes probe scheduling,
  so compare configurations with identical instrumentation. Normal builds retain
  their existing display scheduling. Hardware DMA/TE fault injection is pending.
- The tick-hook CPU sampler and local-heap-minimum override were removed. Runtime
  snapshots report their own duration, task identity, priority and affinity every
  10 s; affinity is not actual per-core execution for unpinned tasks. Boot heap
  minimum and once-per-second sampled minimum are explicitly different fields.
- Link diagnostic state is atomic. The WS task publishes its own stack watermark
  on connection/error/disconnection, with additional samples at most once per
  second in probe builds. No stack scan runs on every normal data callback and
  no deleted task handle is used at teardown.

Validation of the replacement: all 20 host tests passed (19.04 s), including the
new pure-C probe suite and UI action-safety checks; normal and enabled ESP-IDF
`build size` passed, as did `git diff --check`. The movement-release regression
failed before its guard fix. The enabled image is 1548046 B; normal is 1541230 B.
Enabled DIRAM is 164206 B versus 158714 B normal (+5492 B static code/data), plus
the 4096-byte probe task stack and FreeRTOS trace/runtime overhead. These linked
sizes are not a measurement of free internal heap or the total runtime cost.

For a measurement build from **fresh main**, use a separate build/configuration
with these scratch defaults in addition to `sdkconfig.defaults`:

```text
CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS=y
CONFIG_FREERTOS_RUN_TIME_COUNTER_TYPE_U64=y
CONFIG_FREERTOS_RUN_TIME_STATS_USING_ESP_TIMER=y
CONFIG_AELYS_PERF_PROBE=y
CONFIG_AELYS_METRICS_PERIOD_S=10
CONFIG_AELYS_LINK_CHAOS_S=60
```

Verify the resulting configuration actually enables the probe, then app-flash
only to a port verified as Espressif 303A:1001. Never guess from the first USB
serial path (a phone can expose one too). Restore a normal fresh-main app image
after the capture. Do not erase/re-pair/re-provision or run audible checks.

Remaining measurement limits: cumulative worst frame includes boot and screen
switches; the histogram excludes interrupted swipes and is therefore biased
toward quiet periods. Report failure/interruption counts alongside it. The
per-task/serial logging cost, TLS/snapshot correlation, paired-board heap dip,
memory experiments and all original board budget gates remain open. No new
measurements were possible while the board was absent from the Mac USB inventory.
