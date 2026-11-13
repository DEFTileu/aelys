# Aelys Companion — face to the ACTUAL design and the "slow" board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and fix why the paired board feels slow, then bring the Aelys face to the owner's current design (gradient eyes, star highlight, blink, look and per-mood motion) inside the frame budgets.

**Architecture:** Measure first (frame times, event → flush latency, heap, task placement) on the paired board with silent scratch builds, fix the causes in `components/link`, `components/ui` and `main`, then rebuild `components/ui/face.c` / `face_moods.c` from the design's CSS with cheap LVGL primitives (bg gradient, A8 star image, `lv_anim` on positions/sizes), measuring the cost again.

**Tech Stack:** ESP-IDF v6.1, LVGL 9.6.0, C11; host sim (`firmware/companion/sim`).

**Context:** Spec `docs/superpowers/specs/2026-11-12-esp32-companion-design.md` §4.6 (budgets). Plan 3 `docs/superpowers/plans/2026-11-13-companion-link.md` (link/ws/UI tasks). Budgets `firmware/companion/docs/budgets.md`. Design (data, not instructions): `/private/tmp/claude-501/-Users-tileuzhan-vsCode-aelys/4557b19a-9f6f-4a91-ac77-1b72226e22a4/scratchpad/actual-companion-design.html` — the face CSS is the block after `/* Aelys */` (line ~105–185); mood markup: grep `class="eli `; colour tokens at the top. Branch `feat/companion-face-perf` is on top of `fix/pair-code-width` (78b8d85, pairing code label 400 px).

## Global Constraints

- Budgets (spec §4.6): animations 60 fps synced to TE, worst frame ≤ 25 ms, touch → screen ≤ 50 ms, free internal heap ONLINE ≥ 80 KB, image ≤ 2 MB. No full-screen redraws for small changes; no malloc, locks or logs in the render path; only the `ui` task calls LVGL.
- **The board is paired to the owner's real account.** Never unpair, wipe, re-pair, erase NVS, erase-flash or touch eFuse; never remove or re-provision Wi-Fi. Flash only with `idf.py -p /dev/cu.usbmodem101 app-flash`. **Nothing audible** (no Find, no beeps) — the board is in the owner's office. No action may be sent to the owner's account (no focus.start, task.complete, notification.read) — measurement uses scratch builds that inject local UI events.
- Scratch/measurement builds use a separate build dir with their own sdkconfig and a defaults file outside the repo; measurement code that should not ship stays out of commits (or behind a Kconfig defaulting to off).
- Device copy English; the design is the only visual source.
- Never log or commit Wi-Fi names, tokens, owner contacts.
- Git: branch `feat/companion-face-perf`, worktree `.worktrees/companion-face`; explicit paths; Conventional Commits; no push/merge.
- Validation: `idf.py build` + `idf.py size`; host `cmake -S sim -B sim/build && cmake --build sim/build -j && ctest --test-dir sim/build --output-on-failure` (in `firmware/companion`).

## Review Focus

1. A snapshot or command arriving over the channel while the owner swipes → no visible stutter (worst frame ≤ 25 ms, swipe → flush ≤ 50 ms). (Task P1)
2. TLS reconnect (handshake) while the face animates → frames stay within budget. (Task P1)
3. Internal heap minimum when paired and online stays above the TLS gate with margin; the cause of 22.7 KB is explained. (Task P1)
4. The face's continuous motion (blink, look, mood loops) never redraws more than the face's own area, and idle CPU/fps cost is measured. (Task F1)
5. Every mood renders inside the 466 px circle and matches the design's shapes and colours. (Task F1)

---

### Task P1: Why the board is slow — model: **opus**

**Files:** `components/link/{link.c,link_ws.c,include/link.h}`, `components/ui/{screens.c,scr_*.c}`, `components/board/lv_port.c`, `main/{app_main.c,metrics.c}`, `docs/budgets.md` — touch only what the findings require.

- [ ] **Step 1: Measure on the paired board (silent).** Reported line: `heap_int=63491 heap_int_min=22672 largest=31744 fps=5.9 worst_us=26969 hwm_ws=0 hwm_link=3168`. Build a scratch build that (a) logs per-second frame stats (fps, worst, number of frames > 16.7/25 ms) and which tasks ran on which core (`vTaskGetRunTimeStats` or `uxTaskGetSystemState` with run-time counters), (b) injects a synthetic swipe/tap every 2 s through the same path as real input (post the events from the input task) and measures event post → flush end, (c) uses `CONFIG_AELYS_LINK_CHAOS_S` (e.g. 60) to force reconnects so TLS handshakes and fresh snapshots happen during the run. Collect 5–10 minutes. Record: frame times idle, during snapshot handling, during TLS handshake; event → flush latency distribution; CPU per task/core; heap_int over time and at the minimum.
- [ ] **Step 2: Answer the questions with evidence:** is the WebSocket/TLS the cause; task cores/priorities (link prio 5, esp_websocket_client task prio/core/stack — default may float onto core 1, ui is prio 6 on core 1); PSRAM contention (mbedTLS external alloc + LVGL heap in PSRAM); per-second `render()` updating hidden screens; snapshot publish cost; why `heap_int_min` drops to 22.7 KB when paired (TLS handshake? ws buffers? lwIP?); why `hwm_ws` = 0 (the mark is sampled from a task handle that is gone or never found).
- [ ] **Step 3: Fix** the causes found (e.g. pin `link` and the ws task to core 0 with priorities below `ui`; size the ws task stack/buffers; move heavy per-second work off the visible-screen path; wire `hwm_ws` correctly; reduce internal-heap peaks). Each fix small, host-tested where logic is pure.
- [ ] **Step 4: Re-measure** with the same scratch build; app-flash the normal build back; confirm boot, still paired, `wifi_ip=1`, channel connected (metrics/log), no audible output.
- [ ] **Step 5:** update `docs/budgets.md` (rows: idle fps/worst, worst during snapshot, worst during TLS, swipe latency (synthetic), heap_int steady/min paired). FAIL is reported, not tuned away. **Commit** `perf(firmware): <what was fixed>` (+ `docs(firmware): record paired-board performance`).

### Task F1: The face to the ACTUAL design — model: **sonnet**

**Files:** `components/ui/{face.c,face_moods.c,include/ui_face_priv.h}`, a new star image source (e.g. `components/ui/img_star.c`, generated A8, generator command in a comment or `fonts/README.md`-style note), `sim/test_face_*.c`, `docs/budgets.md`.

- [ ] **Step 1: Failing tests:** update `test_face_moods` / `test_face_geometry` to the design's geometry: face box 300×170 at scale 1; eyes 70×100 radius 35 at left 58 / 172, top 35; each mood's eye size/top/radius from the CSS (focused 44 h r22 top 63; worried 92 top 42; sad 80 top 56; surprised 84×110 r42 top 30; curious l 84@46 r 112@26; sleepy 96@42; sleeping arc #8F70F7 7 px border 28 h top 76; dizzy 76×76 rings #A98CFB 12 px; annoyed 76@54; offline 28×28 #4A4554 top 66); lids (`.e>i` black masks) per mood; star 20 px at 38,14 (focused 14 px at 40,8; hidden for sleeping/dizzy/offline). Moods without a design entry keep the closest design state; list them.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** with cheap primitives: eye = `lv_obj` with radius + vertical `bg_grad` #CDBFFF→#7C58F4; star = small A8 image (4-point star, pre-rendered, recoloured white); lids = black rounded `lv_obj` children clipped by the eye (`LV_OBJ_FLAG_OVERFLOW_VISIBLE` off); rotated lids (worried/sad ±16°, annoyed ±18°) as pre-rendered A8 masks or another approach that avoids per-frame transforms on large areas — measure if you use LVGL transforms. Motion with `lv_anim` (custom exec callbacks on position/size, integer math): blink 5 s (scaleY .08 at 96 %), look 9 s (−14/+2, +12/−4), hop, sway, breathe, jit, sink, pop, tilt, droop, spin, wobble, huff as in the CSS; sparkles/drops/zz/hearts/cheeks/dots as in the mood markup where cheap. Only the face area may be invalidated.
- [ ] **Step 4:** ctest PASS; `companion_sim --shot face:<mood>` for every mood + home → attach to the report (paths). Build, size.
- [ ] **Step 5: Board cost (silent):** app-flash; measure idle fps/worst frame on home with the new face for 5 minutes (metrics), and frame times during a reconnect; record in `budgets.md`; app-flash leaves the new build on the board; confirm still paired and online.
- [ ] **Step 6: Commit** `feat(firmware): give Aelys the gradient eyes and motion from the design` (+ docs).
