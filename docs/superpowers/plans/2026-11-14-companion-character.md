# Companion character v2 implementation plan

> **For agentic workers:** Use superpowers:executing-plans (or subagent-driven-development) task by task; check items only after verification. The owner requested autonomous decisions, recorded in the local ledger.

**Goal:** Make Aelys an expressive partner with the design's character states, smooth transitions, explainable priority selection, and silent-on-board event cues.

**Architecture:** Keep a pure C character engine independent of LVGL, hardware and sound output. It consumes explicit inputs and timestamped events, chooses the first applicable of seven priority levels and returns an emotion plus a stable reason. A table of numerical eye targets and a bounded fixed-point spring drive the existing LVGL face; existing screen and link contracts remain intact. Host-only cue output consumes selected event transitions; firmware has no path to play these cues.

**Tech stack:** ESP-IDF 6.1, C11, LVGL 9, CMake/ctest host simulator. No new dependencies.

**Spec:** local, ignored `firmware/companion/design/ACTUAL AELYS Companion.dc.html`, section “2 · Элис / Эмоции”; `firmware/companion/docs/HANDOFF.md`; objective file `goal-objective.md`. Read the local design without copying its owner contact information. Pip-KeyPet is conceptual reference only: independently authored Aelys code.

## Constraints and decisions

- Partner, no feeding or pet needs. Face may render at 30 fps; navigation stays 60 fps. Preserve PSRAM allocation and 32 KB data cache; do not claim board performance from a simulator.
- Seven priorities, in order: sleep; body; transient reaction (2–5 seconds); urgent; mode; day summary; time of day. Record a machine-readable reason for the winning predicate, including after a transient expires.
- The design counts 33 entries, including “always level”, an orientation behavior rather than a discrete mood. Implement the other 32 as distinct named emotion rows and retain level orientation as an independent state/input for S3. Do not fabricate a 33rd mood. Track this interpretation for owner review.
- Twenty design input categories: touch, double touch, slow stroke, frequent pokes, hold, buttons, lift, shake, tilt/rotation, face down, fall, loud sound, ambient level, battery/charging, tasks/deadlines, focus, calendar, notifications, link, time of day. Missing producers stay explicitly unknown, never inferred as false or fabricated; later stages may feed the interface.
- Cues are short (at most 500 ms) and event-only: joy, elation, surprise, fright, tenderness. The detailed emotion captions mention other sounds, but the design's explicit sound rules limit cues to these five; record this choice. Quiet mode, night and focus suppress all cues. Build the board with no cue playback path regardless of settings.
- Preserve existing pairing, privacy and offline behavior. No changes to NVS, network settings, account state or speaker output on hardware.
- S1 hardware checks remain pending while no board is attached; its measured cache improvement is retained and sparse redraw stays disabled. Do not infer timing or heap from emulator.

## Review focus

- All priority collisions, boundary times (<600 s and <3600 s), missing clock and expired events select the correct reason.
- Monotonic time wrap, long hidden intervals and switching targets mid-animation do not jump, overflow or lock the spring.
- A reconnect or repeated snapshot does not retrigger a cue; night, focus and quiet mode always silence it.
- Missing sensor/backend inputs do not masquerade as charging, a finished day, an absent network or a fabricated event.
- All 32 emotion rows render in the circular viewport; larger face never obscures the clock, agenda, orbit or welcome copy.

## Task 1: Pure character selection and event rules

**Files:** create `firmware/companion/components/logic/include/character.h`, `components/logic/character.c`, `sim/test_character.c`; modify logic and sim CMake files.

**Interfaces:** Define `character_inputs_t`, `character_event_t`, `character_state_t`, `character_result_t` and `character_reason_t`. `character_init(character_state_t *)`; `character_event(character_state_t *, character_event_t, uint32_t now_ms)`; `character_select(character_state_t *, const character_inputs_t *, uint32_t now_ms)` returns mood ID and reason. Use unsigned subtraction for bounded 2–5 s event expiry; reject future/invalid event IDs. Inputs include validity for data that can be absent.

- [ ] Write table-driven tests for each of the seven priority levels, every adjacent collision and their reason codes; deadline boundaries 0, 599, 600, 3599, 3600 seconds and overdue; active event lifetime and wraparound; stale/missing inputs; focus >25 minutes/third session; all-done only when total >0; no repeated background selection; sound permissions.
- [ ] Run `cmake -S firmware/companion/sim -B firmware/companion/sim/build && cmake --build firmware/companion/sim/build -j8 && ctest --test-dir firmware/companion/sim/build -R '^test_character$' --output-on-failure`; first confirm expected failure.
- [ ] Implement the engine with deterministic rules. Specify unspecified time-of-day, idle and event duration thresholds in comments and the local ledger as provisional implementation choices. Keep unavailable producers unknown.
- [ ] Re-run targeted tests, full ctest and firmware build; commit only this coherent engine and tests with a Conventional Commit.

## Task 2: Parametric face and spring transitions

**Files:** `components/ui/include/ui.h`, `components/ui/include/ui_face_priv.h`, `components/ui/face_moods.c`, `components/ui/face.c`, `sim/test_face_moods.c`, `sim/test_face_geometry.c`.

**Interfaces:** Each character mood has a numerical target row including both eye geometry/lids/highlights and motion/particle parameters. Expose a pure bounded fixed-point spring step with elapsed time; face creation initializes current values, mood changes replace targets without resetting current position, each 30 fps tick advances springs. Preserve existing UI callers while migrating names deliberately.

- [ ] Add failing tests that enumerate every emotion row, enforce distinct valid geometry where design differentiates it, check convergence/no discontinuity across mood changes and elapsed-time wrap, and compare partial redraw pixels to a full redraw across transitions. Include long-hidden resume and no new style allocations after creation.
- [ ] Implement rows and spring-driven rendering; ensure rare shapes and particles work, and retain existing gradient, highlight and clips. Use arithmetic with documented bounds; no per-frame internal heap allocations.
- [ ] Run targeted and full ctest, `idf.py build`; capture sim images of every character state into the stage ledger folder and visually inspect them. Verify fixed fixtures and wrap regression; record board frame/heap as pending. Commit the coherent change.

## Task 3: Integration, home layout and host-only cues

**Files:** `components/ui/mood_rules.c`, `components/ui/screens.c`, `components/ui/scr_home.c`, relevant headers, simulator entry point/tests and host-only audio implementation.

**Interfaces:** Translate existing snapshots, link state and completion edges into `character_inputs_t`/`character_event_t` without inventing missing sources. Keep engine state across renders. Deliver sound events only to an implementation compiled into the host simulator; the board build must have no path to the speaker for character cues.

- [ ] Test actual Home state and selection across snapshots, completion edge, offline/reconnect, urgent/focus collisions and unavailable sources. Verify sim cue mapping, duration <=500 ms, no duplicate cues, and silence under quiet/night/focus; verify firmware build excludes cue playback.
- [ ] Enlarge only the Home face to scale 130 (390×221 box, eyes approximately 91×130), moving the clock and agenda toward edges while keeping text, orbit, offline and welcome states legible. Use screenshot and geometry tests for normal, welcome, empty, long task and offline cases; navigation remains at 60 Hz.
- [ ] Execute full host tests and normal `idf.py build`; save and inspect all new screen/state shots. Record exact results, branch/commits, pending board measurements and owner decisions in the stage ledger and local Russian handoff. Never flash until the required sim shots exist. Commit the integration.

## Stage gate

All 32 emotion rows plus level behavior, all seven priority steps and 20 input categories must be represented and tested; trace which producers are unavailable until S3/S4/S7/S9. All host tests and IDF build pass; shots exist. Explicitly mark S1 timing/heap and S2 face fps/internal heap pending board, and do not claim a complete hardware stage or 60 fps from host timing. No merge, push or PR.

## Task 4: Owner-visible character reason

The existing metrics interval is 300 s and the app polls every 5 s, so it cannot carry 3 s reactions faithfully. Add a small, owner-only character-status channel: one current mood/reason plus the most recent transient reaction and server-received time. Keep only these two records, no free text, task titles, audio or sensor samples. This is derived ephemeral status; the board coalesces it and resends its latest value on reconnect, with no durable user mutation or command queue.

**Ordering:** Each authenticated WebSocket connection gets a new monotonically increasing server-side epoch under the existing per-device state row lock. Device messages carry a strictly increasing per-connection `seq`; accept only the current epoch and a greater sequence, making duplicates and stale/replaced sockets no-ops. A fresh connection resets the sequence and sends the current state. On reboot the connection gets another epoch. Retain the last reaction with its server timestamp so the 5 s app poll can show it as recent instead of claiming it is current. Status received on an old or revoked device session is never accepted as a newer report. Do not send status while lost mode is active. Each report also carries the board’s applied `lost_rev`; the server rejects reports whose revision differs from its current lost-mode revision, including delayed pre-loss frames after restoration.

**Files:** `backend/app/companion/{models,channel,commands}.py`, new Alembic migration after current branch head, backend companion tests, `firmware/companion/components/{logic,link,ui}`, simulator tests, `apps/web/src/lib/companion/types.ts`, existing device overview and its tests, `docs/companion-protocol.md`.

- [ ] Add backend RED→GREEN tests for strict allowlisted mood/reason values, owner-only reads, duplicate/out-of-order sequence, replaced connection fencing, reconnect/reboot epoch, recent-reaction retention, lost-mode privacy and backwards-compatible absent status. Use row locking and a reversible migration; no log of character data.
- [ ] Add a portable bounded C status publisher with coherent one-writer/one-reader transfer, per-connection sequence, unchanged-value coalescing, resend on reconnect, bounded non-blocking behavior, and no frontend secrets; test clock wrap, races, reconnect, queue pressure, and failed sends. Encode only allowlisted stable string IDs, no arbitrary text.
- [ ] Connect the link task, preserving loss/reconnect behavior and user action priority; UI records changes even when Home is hidden. Board output remains silent.
- [ ] Add the existing owner device overview's current reason and time-limited recent reaction using typed response data. Treat offline/lost/stale status honestly and handle absent/unknown values. Test owner page rendering, stale data and backwards compatibility.
- [ ] Run host ctest, IDF build, backend companion tests including migration checks, web tests/typecheck and branch review; document any unavailable Postgres or board evidence. No deploy, push, PR or merge.

**Progress:** Backend persistence and owner read are implemented as an intermediate slice; firmware publication, app rendering, protocol documentation and end-to-end verification remain open. SQLite migration is tested; PostgreSQL and concurrent live reconnect stress remain pending. Do not deploy this slice alone.
