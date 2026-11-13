# P1 measurement probe audit — 2026-11-13

Scope: the seven uncommitted `CONFIG_AELYS_PERF_PROBE` files left in
`feat/companion-face-perf`. This is an audit of a prototype, not board evidence.
The prototype remains disabled and must not be used to accept performance budgets
until the items below are fixed and verified. No device settings or app defaults
are changed by this document.

## Findings before a board run

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
The seven-file probe is excluded from the committed face changes and from these
host claims; it still needs the corrections listed above.
