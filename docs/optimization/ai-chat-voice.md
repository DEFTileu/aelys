# AI chat voice — Phase 4 / AI Core

Owner-requested slice (2026-11-16): add microphone questions and ElevenLabs
read-aloud to the existing Web, macOS and Android AI chat. This extends Phase 4,
not the broader deferred voice-assistant scope.

## Plan and contracts

1. Register authenticated `/api/v1/ai/voice/transcribe` and `/speak`, test
   provider selection, decimal budget reservation, hidden runs and redacted
   failures; regenerate OpenAPI using the CI serializer.
2. Allow both native voice POST routes with slow-call timeouts, bounded upload
   and sufficient response capacity for a 4 MiB MP3 encoded as JSON base64.
3. Add typed `aiVoiceTranscribe(Blob)` and `aiVoiceSpeak(string)` methods; voice
   requests never enter durable outboxes or invalidate domain caches.
4. Reuse the existing recorder in desktop/mobile chat: explicit microphone
   consent, timer, 60-second stop, automatic send and spoken-question answer
   playback, plus manual read/stop on answers. Dispose all media and reject
   stale asynchronous results on navigation/unmount.
5. Restrict native microphone permission to the application origin/audio; keep
   camera denied. Document device verification separately.
6. Run backend tests/ruff/mypy, shared and web checks, native transport tests,
   OpenAPI reproducibility, and independent review before local commits.

## Constraints and assumptions

- Existing owner ElevenLabs selection uses `feature_provider(..., 'voice')`.
  No key is sent to clients, tests use synthetic credentials and mock HTTP.
- Audio stays transient in memory: no DB, disk, logs, sync or offline queue.
  Multipart parsing must not spool recordings to disk.
- Voice requires connectivity; text-chat offline behavior stays unchanged.
- No schema change or SDK is needed. Existing UI styles and icons are reused.
- Browser autoplay can require a further user gesture; errors must offer manual
  read-aloud. Real macOS/Android microphone and playback are not verified on
  device until exercised on physical devices.
- Existing OPEN decisions about Android release acceptance, signing and broader
  voice scope remain OPEN. No push, PR, merge, deployment or APK publication.

## Review focus

Provider failures must finish reserved runs; denied microphone consent must
release tracks; navigation while permission/transcription/TTS is pending must
not send/play in another chat; multipart audio must remain memory-only; native
response bounds must admit the maximum MP3 without relaxing unrelated routes.

## Validation

- Backend focused command (from `backend`):
  `uv run --frozen --python 3.12 --extra test pytest -q tests/test_ai_voice.py tests/test_audio_upload.py tests/test_companion_voice.py tests/test_companion_voice_provider.py tests/test_companion_channel_voice.py tests/test_english_course.py tests/test_openapi_security.py`
  — 106 passed, one existing Starlette deprecation warning.
- Full backend `uv run --frozen --python 3.12 --extra test pytest -q`:
  1,823 passed, 184 skipped, one failure in
  `tests/test_companion_commands.py::test_lost_mode_hides_server_data_and_denies_actions_until_turned_off`.
  Its assertion assumes a task due three hours from now is still today. The same
  failure reproduced on the pre-voice base `f808580d` in a temporary archive.
  Earlier intermediate runs included in-progress code failures and one transient
  `test_tool_completion_race_does_not_save_answer_or_link_action` failure; that
  test passed both on the base and in the final full run.
- Ruff across all ten changed Python files: passed. Standard mypy on the five
  changed production files reports 61 existing errors in 19 imported files,
  with none in the changed production files. Checking changed production files
  plus four focused test files with `--follow-imports=silent` passes (9 files).
  Including the existing companion voice test also reports its pre-existing
  Optional/None fixture type errors; these are not hidden by a new configuration.
- Web: `pnpm --filter @aelys/web test` — 1,039 passed (104 files);
  web/shared `typecheck` passed. Web production build passed with existing
  chunk-size/dynamic-import warnings. No web `lint` script is defined.
- Shared: `pnpm --filter @aelys/shared test` — 82 passed.
- Native transport: `cargo test --manifest-path packages/native-transport/Cargo.toml --locked --offline`
  — 112 passed, 2 existing hardware probes ignored. Existing 8 MiB JSON cap
  accepts the maximum MP3 encoded as base64; no global cap increase was needed.
- macOS permission tests: 3 passed; plist validation and Rust formatting passed.
- Android scripts: `node --test apps/mobile/scripts/*.test.mjs` — 19 passed,
  including compiled Kotlin consent/origin/cancellation behavior with stubs.
  The actual permission helper additionally compiled against Android API 36's
  `android.jar`. Generated Android sources remain ignored/uncommitted.
- OpenAPI generated with the exact CI JSON serializer and synthetic CI secret;
  reproducibility is checked against the committed schema.

## Remaining acceptance

- macOS and Android microphone recording, OS permission prompts, speaker output,
  autoplay behavior and network transport: **not verified on device**.
- Real ElevenLabs calls were deliberately not made; all provider HTTP is mocked.
- A full Android APK/Gradle build was not completed. `tauri android init --ci
  --skip-targets-install` and preparation succeeded. A direct offline Gradle task
  listing stopped because Tauri's build-generated `tauri.settings.gradle` was
  absent; the normal Tauri Android build must generate it. The persistent Wry
  patch is ordered after Rust generation and before Kotlin compilation, and
  template drift fails closed. This still needs packaged/device acceptance.
- No push, PR, merge, deployment, signing or APK publication was performed.
