# Companion voice (phase 5) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold the top key on the board, ask AELYS by voice, hear the answer from the speaker. ElevenLabs Scribe turns speech into text, the owner's chat model answers with a restricted tool set, and ElevenLabs Flash v2.5 speaks the answer.

**Architecture:** Raw 16 kHz / 16-bit / mono PCM travels both ways as binary WebSocket frames on the existing companion channel: no codec and no second TLS session. A per-socket voice turn on the backend buffers the recording, calls Scribe, runs one history-less `run_tool_turn` with an allow-listed registry, sends the answer text, then streams TTS PCM back. On the board the link task owns the voice session: it sends `voice_start`, starts the ES7210 capture, sends audio frames, and feeds received PCM into a PSRAM ring that the audio task plays through the ES8311.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + httpx (backend); ESP-IDF 6.1, C11, esp_codec_dev (ES7210/ES8311), esp_websocket_client, host ctest simulator (firmware); React settings page (one provider tile). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-companion-voice-design.md` (APPROVED 2026-11-15). Parent: `docs/superpowers/specs/2026-11-12-esp32-companion-design.md`.

## Global Constraints

- Push-to-talk only: hold the top key ≥ 400 ms on Home/Today. Recording cap is **20 s = 640 000 B** of PCM, enforced on the board and the server.
- Audio format: `pcm_s16le`, 16 000 Hz, mono, both directions. Binary frames: board → server 3200 B (100 ms); server → board ≤ 4096 B and always an even length.
- ElevenLabs: STT `POST https://api.elevenlabs.io/v1/speech-to-text`, multipart, `model_id` (default `scribe_v1`), `file_format=pcm_s16le_16`. TTS `POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000`, `model_id` default `eleven_flash_v2_5`. Header `xi-api-key`.
- Voice tools are allow-listed by name only: `list_tasks`, `read_calendar`, `create_task`, `create_note`. Writes run directly (no `gate_writes`). No memory, no web search, no conversation history.
- Never store or log audio, transcripts, or answer text (logs carry codes and sizes only). The ElevenLabs key never reaches the board.
- No speaker output at night (22:00–07:00), in lost mode, or with the board's "Sounds" switch off: the board sends `speak: false`, and the server then skips TTS.
- Error codes: `VOICE_NOT_CONFIGURED`, `BUDGET_EXCEEDED`, `VOICE_TOO_LONG`, `VOICE_EMPTY`, `VOICE_UNAVAILABLE`.
- `voice_text` is at most 600 characters. The server cuts it, and the board buffer is 601 bytes.
- Memory gate (spec §6): over 10 turns (20 s recording + 20 s answer), the minimum internal heap drops ≤ 16 KB versus ONLINE without voice over the same hour. Also: largest block ≥ 24 KB, UI at 60 fps with worst frame ≤ 25 ms, and `heap_int` back to its pre-turn value.
- The board never plays sound without the owner's yes. Flashing, merging and deploying also need the owner's yes. Builds come only from fresh `main` (the owner's rule). If plan 4 Task 8 (signed images) has landed, flash only through `tools/flash_signed.py`.
- Repo is public: no personal data. The owner's ElevenLabs key is typed by the owner in Settings.
- Backend changes need an ADR in `docs/DECISIONS.md`: the next free number at the time (ADR-030 unless plan 4 has merged, then the next one). Migration: the next free revision after the newest in `backend/alembic/versions` (`0061` at the time of writing).

## Review Focus

- **Server PCM chunks of odd length or > 4096 B.** ElevenLabs chunk sizes are arbitrary. The board must never receive half a sample or an oversize frame. Test: B2 `test_speak_pcm_reframes_even_and_bounded`.
- **Socket drops mid-turn, or a second `voice_start` while a turn runs.** The old turn is cancelled, no audio leaks into the new turn, and nothing is left running after disconnect. Test: B4 `test_voice_second_start_cancels_first`, `test_voice_turn_cancelled_on_disconnect`.
- **Key held past 20 s.** Recording stops and the turn proceeds. PMIC long-press shutdown stays off until release, then comes back on. The ui never gets stuck in "listening". Test: F1 `talk_feed` cap case; F4 `test_screens` 20 s cap case.
- **Lower key or ICE combo pressed during a hold.** The voice turn is cancelled (`voice_cancel`), ICE still opens, and nothing is recorded after the cancel. Test: F1 `talk_feed` cancel case; F4 screens case.
- **Owner speaks a write the voice may not do** ("закрой задачу", "запомни"). The tool is absent from the registry, the model can only say it cannot, and no row changes. Test: B3 `test_voice_registry_excludes_other_tools`, `test_voice_turn_cannot_complete_task`.

---

### Task B1: ElevenLabs provider kind and `voice` feature

**Files:**
- Modify: `backend/app/ai/api.py:91` (ProviderIn kind pattern), `:258-277` (`_provider_base_url`: default `https://api.elevenlabs.io`, allowed host `api.elevenlabs.io`, path must be empty like `transcription`), `:327-331` (FeatureDefaults `voice`)
- Modify: `backend/app/ai/defaults.py:16-17` — `FEATURES["voice"] = ("elevenlabs",)`
- Modify: `backend/app/ai/egress.py` — allow `api.elevenlabs.io` the same way `api.openai.com` is allowed for transcription (read it first)
- Modify: `apps/web/src/views/ProviderSettings.tsx:15-17,54,93,136-138` — the `elevenlabs` kind tile reuses the transcription layout (key, monthly budget, estimate per request), storing `voice_request_cost` (default `'0.05'`) and `default_model: 'eleven_flash_v2_5'`. Hint text: "ElevenLabs key for the desk board's voice: speech recognition and speech." No new fields (spec §5.3).
- Test: `backend/tests/test_companion_voice_provider.py`, the existing web provider-settings test file

**Interfaces:**
- Produces: provider `kind == "elevenlabs"`; `feature_provider(db, owner_id, "voice")` returns it; `model_policy_json` keys `voice_request_cost`, `tts_model`, `stt_model`, `voice_id`, `monthly_budget`.

- [ ] Write failing tests:
  - `test_elevenlabs_provider_accepts_only_official_host` — `https://api.elevenlabs.io` is accepted; `https://evil.example`, `http://api.elevenlabs.io` and a path are 422 `INVALID_PROVIDER_ENDPOINT`;
  - `test_voice_feature_picks_only_elevenlabs` — with claude + transcription + elevenlabs providers, `feature_provider(db, owner, "voice")` returns the elevenlabs one, and `"chat"` never does;
  - `test_elevenlabs_cannot_be_chat_default` — PUT `/ai/defaults` with `chat` pointing at it is refused (mirror `test_transcription_provider_is_separate_owner_api_and_cannot_be_chat`).
- [ ] Run `cd backend && pytest tests/test_companion_voice_provider.py -q` — expect failures.
- [ ] Implement the backend changes. Then the web tile, plus a web test that saving an `elevenlabs` provider sends `voice_request_cost`.
- [ ] Run the backend tests and `cd apps/web && npm test -- ProviderSettings` (or the repo's web test command) — expect PASS.
- [ ] Commit: `feat(ai): add ElevenLabs provider for board voice`.

### Task B2: ElevenLabs client (STT + streaming TTS)

**Files:**
- Create: `backend/app/companion/voice_provider.py`
- Test: `backend/tests/test_companion_voice_provider.py` (same file as B1)

**Interfaces:**
- Consumes: B1's provider kind.
- Produces:
  - `class VoiceError(Exception)` with `.code: str` (the global error codes);
  - `def voice_transport() -> httpx.AsyncBaseTransport` (monkeypatched in tests, as `transcription_transport` is);
  - `async def voice_provider(db: AsyncSession, owner_id: str) -> tuple[AIProvider, AIProviderSecret]` — raises `VoiceError('VOICE_NOT_CONFIGURED')`;
  - `async def transcribe_pcm(provider: AIProvider, key: str, pcm: bytes) -> str` — timeout 30 s; response body ≤ 100 KB; empty text → `VoiceError('VOICE_EMPTY')`; any other failure → `VoiceError('VOICE_UNAVAILABLE')` with no URL, key or body in the message;
  - `def speak_pcm(provider: AIProvider, key: str, text: str) -> AsyncIterator[bytes]` — yields chunks of even length, each ≤ 4096 B, and carries an odd trailing byte into the next chunk;
  - `DEFAULT_VOICE_ID: str` — one premade multilingual ElevenLabs voice. `shortcut: fixed voice until the owner approves a voice picker mockup`. Verify the id on the owner's account in Task F5.

- [ ] Write failing tests with `httpx.MockTransport`:
  - `test_transcribe_pcm_sends_raw_pcm_multipart` — POST path `/v1/speech-to-text`; header `xi-api-key` equals the decrypted key; form fields `model_id=scribe_v1` and `file_format=pcm_s16le_16`; the file part is the exact PCM bytes; returns `"привет"` from `{"text":"привет"}`;
  - `test_transcribe_pcm_errors_are_generic` (parametrised: 500, non-JSON, `{"text":""}` → `VOICE_EMPTY`, body > 100 KB) — the key never appears in `str(exc)` or `caplog.text`;
  - `test_speak_pcm_reframes_even_and_bounded` — the transport streams chunks of 1, 4095, 9000, 3 bytes. Every yielded chunk has even length ≤ 4096, and their concatenation equals the input minus at most one final odd byte. Request: `output_format=pcm_16000`, `model_id=eleven_flash_v2_5`, voice id from `model_policy_json.voice_id` else `DEFAULT_VOICE_ID`.
- [ ] Run the tests — expect FAIL.
- [ ] Implement, following the structure of `backend/app/integrations/telegram_transcription.py` (transport per call, `aclose` in `finally`, broad except mapped to a generic code).
- [ ] Run the tests — expect PASS. Commit: `feat(companion): ElevenLabs speech client for voice`.

### Task B3: Voice turn (budget, STT, restricted AI turn, TTS)

**Files:**
- Create: `backend/app/companion/voice.py`
- Create: `backend/alembic/versions/0062_companion_voice.py` — adds nullable `companion_state.voice_conversation_id String(36)`
- Modify: `backend/app/companion/models.py:22-41` (`CompanionState.voice_conversation_id`)
- Modify: `backend/app/ai/chat_support.py:115-119` — `system_prompt(..., channel="voice")` uses the Telegram write policy plus `VOICE_STYLE`: answer in 1–3 short sentences, no markdown, no links, in the language of the question; say plainly when something cannot be done by voice
- Test: `backend/tests/test_companion_voice.py`

**Interfaces:**
- Consumes: B2 (`voice_provider`, `transcribe_pcm`, `speak_pcm`, `VoiceError`); `personal_tool_registry` (`backend/app/ai/personal_tools.py:125`); `run_tool_turn` (`backend/app/ai/turn.py:50`); `feature_provider(db, owner, "chat")`; `build_snapshot` (`backend/app/companion/snapshot.py:160`) for focus/weather context.
- Produces:
  - `VOICE_MAX_BYTES = 640_000`;
  - `VOICE_TOOLS = frozenset({"list_tasks", "read_calendar", "create_task", "create_note"})`;
  - `def voice_registry(db: AsyncSession, owner_id: str, event_id: str) -> ToolRegistry` — a fresh `ToolRegistry` with only `VOICE_TOOLS` descriptors copied from the full personal registry;
  - `async def run_voice_turn(owner_id: str, device_id: str, turn_id: str, pcm: bytes, speak: bool, send: Callable[[dict], Awaitable[None]], send_audio: Callable[[bytes], Awaitable[None]]) -> None` — never raises except `CancelledError`. It sends, in order:
    1. `voice_state thinking`;
    2. `voice_text {id, text}`;
    3. `voice_state speaking` (only when `speak` and TTS starts);
    4. audio;
    5. `voice_state done`.

    On failure it sends `voice_state error {error_code}`.

The order inside `run_voice_turn` follows `telegram_personal_dialogue._process` (`backend/app/integrations/telegram_personal_dialogue.py:240-380`):
1. Reserve `voice_request_cost` against `_remaining_monthly_budget` of the voice provider. Create `AIRun` with `idempotency_key=f"companion-voice:{device_id}:{turn_id}"`, then commit.
2. Run STT.
3. Get or create the device's `AIConversation` (title `"Элис — голос"`) from `CompanionState.voice_conversation_id`. Recreate it if it was deleted.
4. Add the user `AIMessage` (transcript) and run the chat-provider `AIRun`.
5. Messages are exactly `(system_prompt(tz, tools=True, channel="voice"), user(snapshot context as untrusted data), user(transcript))`. No history and no memory facts.
6. `PermissionContext(actor=f"companion-voice:{device_id}", scopes=frozenset({"tasks.read","calendar.read","tasks.write","notes.write"}), policy_id="companion-voice")`.
7. Add the assistant `AIMessage`, then send the reply cut to 600 characters.
8. If `speak` is set, stream `speak_pcm` into `send_audio`.

Commit before every provider wait, as the Telegram path does.

- [ ] Write failing tests (fake STT/TTS via `voice_transport`, fake chat service as in the existing Telegram dialogue tests):
  - `test_voice_registry_excludes_other_tools` — `{s["name"] for s in voice_registry(...).schemas()} == VOICE_TOOLS`;
  - `test_voice_turn_creates_task_directly` — transcript "добавь задачу купить молоко", the fake model calls `create_task`. A `Task` row exists, there is no pending `AIAction`, and the sends are `thinking, voice_text, speaking, <audio>, done`;
  - `test_voice_turn_cannot_complete_task` — the fake model calls `complete_task`. The tool is rejected as unknown and the task stays open;
  - `test_voice_turn_has_no_history` — a prior assistant message in the same conversation is absent from the messages the fake model receives;
  - `test_voice_turn_without_speak_skips_tts` — the TTS transport is never called; sends end `voice_text, done`;
  - `test_voice_turn_not_configured` / `test_voice_turn_budget_exceeded` / `test_voice_turn_empty_transcript` — each ends with `voice_state error` carrying the matching code, and no chat run starts;
  - `test_voice_turn_never_logs_text` — the transcript and reply strings are absent from `caplog.text`;
  - `test_voice_conversation_reused_and_recreated_after_delete`.
- [ ] Run `pytest tests/test_companion_voice.py -q` — expect FAIL.
- [ ] Implement the migration (`alembic upgrade head` on the test DB), the model field, `system_prompt` channel, and `voice.py`.
- [ ] Run the tests plus `pytest tests/test_telegram_personal*.py -q` (system_prompt change) — expect PASS. Commit: `feat(companion): voice turn with restricted tools`.

### Task B4: Channel binary frames, voice messages, protocol doc, ADR

**Files:**
- Modify: `backend/app/companion/channel.py` — `_Link` gains `send_audio: Callable[[bytes], Awaitable[None]]` and `voice: "_Voice | None"`; outbox items carry `dict | bytes` and the writer uses `send_bytes` for bytes; `reader` routes `event["bytes"]` to `_audio(link, data)`; new handlers `voice_start`, `voice_end`, `voice_cancel` in `HANDLERS`; on socket end the running voice task is cancelled in the existing `finally`.
- Modify: `docs/companion-protocol.md` — new section "Voice" (spec §5.2 messages, rules, codes)
- Modify: `docs/DECISIONS.md` — ADR: ElevenLabs as the voice vendor (owner's choice, BYOK), raw PCM over the channel, voice tool allow-list, direct writes, no history, no audio stored
- Test: `backend/tests/test_companion_channel_voice.py` (use `companion_helpers.pair_companion` / `companion_token` and the TestClient websocket as in `test_companion_channel.py`)

**Interfaces:**
- Consumes: B3 `run_voice_turn`, `VOICE_MAX_BYTES`.
- Produces (wire, to the board):
  - in: `voice_start {id ≤ 40 chars, rate: 16000, format: "pcm_s16le", speak: bool}`, binary PCM, `voice_end {id}`, `voice_cancel {id}`;
  - out: `voice_state {id, state, error_code?}`, `voice_text {id, text}`, binary PCM.

`_Voice` holds `id`, `speak`, `buf: bytearray`, `task: asyncio.Task | None`. Rules:
- Binary data with no open recording is dropped silently.
- A buffer over `VOICE_MAX_BYTES` → `voice_state error VOICE_TOO_LONG` and the recording is discarded.
- A new `voice_start` cancels the running task and buffer.
- `voice_end` with a matching id starts `run_voice_turn` as a task and releases the buffer reference to it.
- A device in lost mode (`CompanionState.lost_mode_json` on) → `voice_state error VOICE_UNAVAILABLE`.

- [ ] Write failing tests:
  - `test_voice_round_trip` (patched `run_voice_turn` echoes a fixed sequence) — the board receives `voice_text` and a binary frame;
  - `test_binary_without_start_is_ignored` — no reply, socket stays open;
  - `test_voice_too_long` — 640 001 B → `VOICE_TOO_LONG`;
  - `test_voice_second_start_cancels_first` — the first task sees `CancelledError`, no frames of the first turn arrive after the second `voice_start`;
  - `test_voice_turn_cancelled_on_disconnect`;
  - `test_voice_refused_in_lost_mode`;
  - `test_text_frames_still_limited_to_4kb` (regression).
- [ ] Run — expect FAIL. Implement. Run the new file plus `pytest tests/test_companion_*.py -q` — expect PASS.
- [ ] Write the protocol section and the ADR. Commit: `feat(companion): voice frames on the device channel`.

### Task F1: Pure logic — talk key, voice protocol, PWR stale limit

**Files:**
- Modify: `firmware/companion/components/logic/include/gesture.h`, `gesture.c` — the talk detector
- Modify: `firmware/companion/components/logic/include/pwrkey.h`, `pwrkey.c`, `firmware/companion/sim/test_pwrkey.c`, `firmware/companion/components/board/board_input.c:269,275` — stale limit becomes a parameter
- Modify: `firmware/companion/components/logic/include/proto.h`, `proto.c` — voice messages
- Modify: `firmware/companion/components/logic/include/ui_events.h` — `UI_EV_TALK`, `UI_EV_VOICE`
- Test: `firmware/companion/sim/test_gesture.c`, `test_proto.c`, `test_pwrkey.c`

**Interfaces:**
- Talk detector:
  - `typedef enum { TALK_NONE, TALK_SHORT, TALK_START, TALK_END, TALK_CANCEL } talk_t;`
  - `typedef struct { bool top, low, started, cancelled; uint32_t t0; } talk_ctx_t;`
  - `#define TALK_HOLD_MS 400`, `#define TALK_MAX_MS 20000`;
  - `talk_t talk_feed(talk_ctx_t *t, bool top, bool low, uint32_t now_ms);` Events:
    - `SHORT` — top released alone before 400 ms;
    - `START` — top held alone 400 ms;
    - `END` — released after START, or 20 s after START (once);
    - `CANCEL` — low goes down at any point of a top press;
    - nothing more for that press after END or CANCEL.
- PWR key: `bool pwrkey_update(pwrkey_t *k, bool neg, bool pos, uint32_t now_ms, uint32_t stale_ms);` callers pass `PWRKEY_STALE_MS`, or `PWRKEY_STALE_TALK_MS 31000` while the power hold is on (F3).
- Protocol:
  - `MSG_VOICE_STATE`, `MSG_VOICE_TEXT` in `msg_type_t`;
  - union member `struct { char state[12]; char error[24]; char text[601]; } voice;`;
  - `size_t proto_voice_start(char *buf, size_t cap, const char *id, bool speak);` → `{"type":"voice_start","id":…,"rate":16000,"format":"pcm_s16le","speak":…}`;
  - `size_t proto_voice_end(char *buf, size_t cap, const char *id, bool cancel);` → `voice_end` / `voice_cancel`.
- UI events: `UI_EV_TALK` data[0] = `talk_t`; `UI_EV_VOICE` data[0] = `voice_ui_t { VOICE_UI_THINKING, VOICE_UI_SPEAKING, VOICE_UI_DONE, VOICE_UI_ERROR }`, data[1..24] = error code. The answer text goes through a tribuf `ui_voice_tb` (char[601]), like `ui_owner_tb`.

- [ ] Write failing host tests:
  - talk detector: short click; hold → START at exactly 400 ms, not 399; END on release; END at 20 400 ms when still held, then nothing at release; low pressed before 400 ms → CANCEL and no START; low pressed after START → CANCEL; `uint32_t` wrap of `now_ms`;
  - pwrkey: the stale limit honours the parameter (10 500 vs 31 000);
  - protocol: builders produce the exact JSON and return 0 when `cap` is too small; parse `voice_state` with/without `error_code`; `voice_text` of 600 chars kept and 601 cut to 600 at a UTF-8 boundary.
- [ ] Run `cmake -S firmware/companion/sim -B firmware/companion/sim/build && cmake --build firmware/companion/sim/build -j8 && ctest --test-dir firmware/companion/sim/build --output-on-failure` — new tests FAIL.
- [ ] Implement. Re-run the full ctest — PASS. Commit: `feat(companion): talk key and voice messages in the board logic`.

### Task F2: Link — voice session and binary frames

**Files:**
- Modify: `firmware/companion/components/link/link_ws.c:71` — accept `OP_BINARY` (0x2) and its continuations: bytes go straight to `link_deps.audio_in` (no slot, no copy into `rx`); add `bool link_ws_send_bin(const void *data, size_t n);` (under `mu`, `esp_websocket_client_send_bin`)
- Modify: `firmware/companion/components/link/link_priv.h` — `LQ_VOICE_START` (a = speak), `LQ_VOICE_END` (a = cancel) in `lq_kind_t`
- Modify: `firmware/companion/components/link/include/link.h` — deps and public calls below
- Modify: `firmware/companion/components/link/link.c` — handle the two queue events and the `MSG_VOICE_*` frames; post `UI_EV_VOICE` and publish `ui_voice_tb`
- Test: `firmware/companion/sim/test_link_core.c` / `test_link_fsm.c` (whichever owns frame dispatch; read first)

**Interfaces:**
- Deps added to `link_deps_t`:
  - `esp_err_t (*listen_start)(void (*on_pcm)(const int16_t *pcm, size_t samples));`
  - `void (*listen_stop)(void);` — returns after the last chunk is delivered;
  - `bool (*audio_in)(const uint8_t *pcm, size_t len);` — called in the ws task. It may wait ≤ 500 ms for ring space; false → the playback is dropped;
  - `void (*audio_end)(void);`
- Public calls:
  - `bool link_voice_start(bool speak);` — posts `LQ_VOICE_START`; false when offline or the queue is full;
  - `void link_voice_end(bool cancel);`
- Link task, on `LQ_VOICE_START`:
  1. Generate a uuid id.
  2. Send `proto_voice_start`.
  3. Call `listen_start(cb)`, where `cb` batches 1600 samples and calls `link_ws_send_bin`.
- On `LQ_VOICE_END`: `listen_stop()`, then send `voice_end` / `voice_cancel`.
- `MSG_VOICE_STATE done|error`: `audio_end()`, then post `UI_EV_VOICE`.
- Socket closed during a session: stop listening, post `VOICE_UI_ERROR "OFFLINE"`.

- [ ] Write failing host tests for the link-core state: no `voice_start` while offline; START then END sends exactly `voice_start, voice_end` in order; a close mid-session posts the OFFLINE error once; a `voice_state` for a stale id is ignored.
- [ ] Run ctest — FAIL. Implement. Run ctest + `idf.py -C firmware/companion build` — PASS.
- [ ] Commit: `feat(companion): voice session and binary frames in the link`.

### Task F3: Board audio — ES7210 capture, streaming playback, PMIC power hold

**Files:**
- Modify: `firmware/companion/components/board/board_audio.c` (+ `include/board.h`)
- Modify: `firmware/companion/components/board/include/board_pins.h` — `PIN_I2S_DIN GPIO_NUM_10`, `I2C_ADDR_ES7210` (from the Waveshare BSP `waveshare/esp32_s3_touch_amoled_1_75c` 3.0.0)
- Modify: `firmware/companion/components/board/board_input.c` — power hold
- Modify: `firmware/companion/main/app_main.c` — wire the F2 deps
- Modify: `firmware/companion/main/metrics.c` — a `voice` perf line at the end of each turn: heap min during the turn, largest block, worst frame

**Interfaces:**
- Capture: `esp_err_t board_audio_listen(void (*on_pcm)(const int16_t *pcm, size_t samples));` and `void board_audio_listen_stop(void);`
  - opens I2S0 with both handles (`i2s_new_channel(&cc, &tx, &rx)`) and the ES7210 via `es7210_codec_new`;
  - 16 kHz, mono to the callback (pick or mix the two mics — calibrate on the board);
  - DMA descriptors internal (≤ 3 KB), everything else in PSRAM.
- Playback:
  - `esp_err_t board_audio_play_begin(void);` — allocates a 256 KB PSRAM byte ring and starts the audio task in "stream" mode (mono → both slots, `BEEP_VOLUME`-style volume constant `VOICE_VOLUME`);
  - `bool board_audio_play_push(const uint8_t *pcm, size_t len, uint32_t wait_ms);`
  - `void board_audio_play_end(void);` — drains the ring, then tears down as today.
- Precedence: "Find Aelys" (`board_audio_beep`) and `board_audio_stop` end capture/stream. `board_audio_sfx` is dropped while a voice session is open.
- Power hold: `void board_input_hold_power(bool on);`
  - sets an atomic; the input task applies it on its next 20 ms pass;
  - on → clear AXP2101 PWROFF_EN (0x22) bit 1 (verify against the datasheet / XPowersLib `disableLongPressShutdown`);
  - off → set it;
  - also off on top-key release, 30 s after on, and at boot in `axp_pwrkey_init`;
  - while on, `pwrkey_update` gets `PWRKEY_STALE_TALK_MS`.

- [ ] Build: `idf.py -C firmware/companion build` — PASS. No host test covers the I2S/I2C paths; the board steps below are the test.
- [ ] Board, silent (owner's yes to flash, nothing audible):
  - confirm the PWR key is the top key (the `board_input.c` shortcut);
  - with the hold on, a 15 s press does not power the board off; with it off, a 10 s press still does;
  - record 20 s ten times into the ring and discard;
  - log the `voice` perf line;
  - check the §6 memory gate against an hour of ONLINE without voice.

  If the gate fails, stop: free memory first, starting with the unexplained 41 KB `heap_int_min` in `firmware/companion/docs/next-steps.md`.
- [ ] Commit: `feat(companion): microphone capture, stream playback and power hold`.

### Task F4: UI — talk flow on Home/Today

**Files:**
- Modify: `firmware/companion/components/ui/screens.c:1088-1105` (key handling), `:143-153` (sound rule reused for `speak`)
- Modify: `firmware/companion/components/board/board_input.c:281` — post `UI_EV_TALK` from `talk_feed` next to `btn_feed`
- Test: `firmware/companion/sim/test_screens.c`

**Interfaces:**
- Consumes: F1 `UI_EV_TALK`, `UI_EV_VOICE`, `ui_voice_tb`; F2 `link_voice_start/end`; F3 `board_input_hold_power`.
- Behaviour:
  - Home/Today only, not in lost mode: `BTN_TOP` is ignored there, and `TALK_SHORT` opens the menu.
  - `TALK_START`: `link_voice_start(speak)`, where `speak = ui_sound_on() && !night && !lost`. On false, show the toast "Нет связи". On success: `board_input_hold_power(true)` and mood `attention`.
  - At 17 s a short visual cue.
  - `TALK_END`: `link_voice_end(false)`, hold off, mood `thinking`.
  - `TALK_CANCEL`: `link_voice_end(true)`, hold off, back to the normal mood.
  - `UI_EV_VOICE`:
    - SPEAKING / DONE → `scr_notice` with the `ui_voice_tb` text;
    - ERROR → short toast per code (`VOICE_NOT_CONFIGURED` "Голос не настроен", `BUDGET_EXCEEDED` "Бюджет AI исчерпан", `VOICE_TOO_LONG` "Слишком длинно", `VOICE_EMPTY` "Не расслышала", `VOICE_UNAVAILABLE`/`OFFLINE` "Не получилось").
  - A new `TALK_START` while an answer plays → `board_audio_stop()` first.
  - Low key closes the notice as today.

- [ ] Write failing sim tests in `test_screens.c` (fake `link_voice_*` and hold hooks):
  - short top on Home opens the menu on release, not on press;
  - hold → `voice_start(speak=1)` + attention mood;
  - at night or with Sounds off → `speak=0`;
  - lost mode → no voice;
  - CANCEL via low key → `voice_end(cancel=1)` and the ICE combo still fires;
  - the 20 s END arrives while held → thinking, hold released;
  - the ERROR codes show their toast;
  - on Focus/Tasks/Timer/Games the top key keeps its action and never starts voice.
- [ ] Run ctest — FAIL. Implement. Run full ctest + firmware build — PASS. Save sim shots for listening / thinking / answer notice and inspect them.
- [ ] Commit: `feat(companion): hold the top key to talk to AELYS`.

### Task F5: End-to-end on the board

- [ ] With the owner's yes to sound, flash fresh `main` with B1–F4 merged. The owner adds the ElevenLabs key under Settings → AI providers. Run "что у меня сегодня?", "добавь задачу купить молоко завтра", "закрой задачу купить молоко" (must refuse), and a 25 s hold (cut at 20 s).
- [ ] Measure release → first sound over 10 turns (target ≤ 4 s) and re-run the §6 memory gate with playback on. Confirm the conversation "Элис — голос" shows in AI Chat with text only.
- [ ] Record the numbers, the confirmed `DEFAULT_VOICE_ID`, the verified PWROFF_EN bit and the PWR = top key mapping in the ADR and `firmware/companion/docs/next-steps.md`. Commit: `docs(companion): record voice latency and memory on the board`.
