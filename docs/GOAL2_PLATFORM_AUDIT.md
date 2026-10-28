# Goal 2 — Platform and Security-Sensitive Audit

**Дата аудита:** 2026-10-28

**Объект:** Goal 2: `PROJECT_CONTEXT.md`, `DECISIONS.md`, `PRD.md`, `ARCHITECTURE.md`, `API_CONTRACTS.md`, `SYNC_PROTOCOL.md`, `AGENT_RUNTIME.md`, `AI_HARNESS.md`, `SECURITY.md`, `ACCEPTANCE_TESTS.md`, `IMPLEMENTATION_PLAN.md`, backend OpenAPI и `apps/runtime`.

**Ограничение аудита:** проверены исходные файлы, документация, генерируемая OpenAPI-схема, локальный toolchain и доступные unit/integration tests. Рабочий/packaged Tauri application flow, установочный пакет, Android APK, подписанный macOS bundle, deployment entitlements, production Keychain и внешний backend deployment не представлены. Поэтому отсутствие такого evidence трактуется как `не подтверждено`, а не как успешная platform validation.

## Итоговая оценка

Goal 2 пока находится на уровне backend/runtime foundation и security spikes. Документы согласованы с главным направлением: локальные полные agent sessions, минимальный cloud metadata, offline-first sync и fail-closed execution. `apps/runtime` уже содержит полезные защищённые seams и тесты. Однако platform integration не завершена и не должна объявляться готовой:

- Tauri 2 macOS и Android shell scaffolds появились, host Rust checks проходят после добавления RGBA icon assets, но helper/IPC, real native storage/auth integration and packaged platform builds ещё не подтверждены; runtime прямо описан как headless library для будущего встраивания.
- Android wrapper остаётся `OPEN`/`SPIKE`; scaffold есть, но нет достаточного toolchain/build evidence для Tauri Android.
- Реальная macOS OS-level isolation validation не подтверждена: production validator намеренно возвращает `Unavailable`, а успешные тесты используют synthetic report.
- Live session search сейчас возвращает `MAC_OFFLINE`, а agent-run SSE отдаёт только текущий status, поэтому описанные remote-control сценарии не end-to-end.
- В WebSocket metadata path и HTTP session search проверяется владелец, но не project grant/tool scope, который требуется архитектурой.
- Backend OpenAPI воспроизводится и совпадает с сохранённым snapshot по путям и методам, но схема не описывает bearer security scheme; `Authorization` выглядит как необязательный header.

До закрытия P0/P1 ниже unattended vendor execution должен оставаться отключённым. Это соответствует текущему fail-closed поведению runtime.

## Evidence snapshot

| Область | Подтверждённое evidence | Статус границы |
|---|---|---|
| Решения и scope | `docs/PROJECT_CONTEXT.md:22-28`, `docs/DECISIONS.md:8-22`: macOS Tauri 2 decided, Android Tauri 2 proposed/spike, SQLite/IndexedDB and WS proposed | Правильный статус решений сохранён; Android и transport нельзя считать окончательными |
| Product/security requirements | `docs/PRD.md:70-89`, `docs/SECURITY.md:37-89`, `docs/AGENT_RUNTIME.md:69-83` | Требования к grant, sandbox, credentials и local-only данным сформулированы, но часть runtime boundaries ещё не реализована |
| Offline sync design | `docs/SYNC_PROTOCOL.md:7-25`, `:44-63`, `:86-95`; backend `backend/app/sync/*` и tests | Backend sync core и shared IndexedDB/outbox primitive покрыты tests; integration with real web/native clients and crash recovery не подтверждены |
| Runtime privacy | `apps/runtime/src/metadata.rs:5-49`, `apps/runtime/src/db.rs:40-84`, `:189-215`; `runtime_contracts.rs:145-176` | Allowlist и local FTS существуют; Tauri/helper packaging и real deployment boundary отсутствуют |
| Runtime fail-closed | `apps/runtime/src/isolation.rs:65-85`, `apps/runtime/src/runner.rs:68-103`, `apps/runtime/src/adapter.rs` | Код не должен запускать vendor CLI без gate; реальная gate validation не подтверждена |
| Backend API | Generated app schema: OpenAPI 3.1, 65 paths; snapshot comparison produced no path/method differences | Schema snapshot актуален по текущему app; security semantics и функциональная полнота всё ещё требуют hardening |

## 1. Architecture and platform boundaries

### macOS Tauri 2

Документы описывают macOS через Tauri 2 + Rust (`docs/PROJECT_CONTEXT.md:22-27`, `docs/DECISIONS.md:8-10`), а `docs/AGENT_RUNTIME.md:11-17` требует Tauri desktop app, opt-in helper и outbound authenticated channel. Сейчас `apps/desktop` содержит Tauri 2 scaffold, config, minimal capability и две read-only commands (`apps/desktop/src-tauri/tauri.conf.json:1-32`, `apps/desktop/src-tauri/capabilities/default.json:1-8`, `apps/desktop/src-tauri/src/lib.rs:11-40`). Это полезная boundary, но отсутствуют macOS entitlements, helper launch/install definition, authenticated runtime IPC, local store/Keychain integration и bundle/signing configuration. `apps/runtime/README.md:1-5` по-прежнему называет crate headless runtime library, которая будет embedded by a future Tauri/helper layer.

Вывод: Rust runtime library соединена со scaffold через path dependency и bounded capability/status probes, но не через полный product path. Нельзя утверждать, что onboarding, device enrollment, local store, Keychain, helper lifecycle или authenticated runtime IPC работают через Tauri. Host `cargo check` и `pnpm --filter @aelys/desktop tauri:build` проходят и дают release binary; это не подтверждает запуск окна, helper lifecycle, signing или notarization.

### Android Tauri 2 feasibility

Решение остаётся `PROPOSED / SPIKE` (`docs/DECISIONS.md:8-10`), а конкретные blockers перечислены в `docs/PROJECT_CONTEXT.md:24-27` и `docs/OPEN_QUESTIONS.md:5-12`: background sync/push, notifications, secure storage и APK. `apps/mobile` теперь содержит только Tauri shell scaffold; README прямо запрещает считать его Android support (`apps/mobile/README.md:1-20`), а native SQLite adapter оставлен follow-up (`apps/mobile/src-tauri/src/lib.rs:10-16`).

На аудируемом checkout:

- отсутствуют generated Android project/manifest/Gradle build output и device validation; есть только `apps/mobile/src-tauri` Tauri config/capability scaffold, Capacitor fallback не выбран;
- `tauri`, `adb`, `sdkmanager` и `rustup` отсутствуют в `PATH`;
- `java` доступна (`OpenJDK 21.0.11`), в `~/Library/Android/sdk` присутствуют `platform-tools`, build-tools 34/35/36 и Android platforms 34/35/37, но `adb` не доступен через toolchain path и Android Rust targets нельзя проверить через отсутствующий `rustup`;
- Xcode toolchain не установлен как active Xcode: `xcodebuild -version` вернул ошибку, что active developer directory — Command Line Tools; `xcrun --sdk macosx --show-sdk-version` вернул `26.5`.

Локальный Tauri CLI 2.12.4 доступен через workspace `node_modules/.bin`, а не через global `PATH`. После добавления icon asset `cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml` проходит на host target; это не Android build result. Наличие отдельных SDK directories не является evidence, что Tauri Android или APK build feasible. Нужен отдельный reproducible spike на машине с установленными Rust Android targets, Android command-line tools/Gradle и проверкой background execution, notifications, secure storage, TLS/auth и offline sync. До этого ADR-006 должен оставаться open.

### Authentication and local-runtime communication

Текущая рабочая граница выглядит так:

1. Backend WebSocket `backend/app/agents/api.py:103-117` принимает только Bearer access token с `device_id`, проверяет access token, owner, platform и revocation.
2. При каждом сообщении backend обновляет состояние device и закрывает соединение после revocation (`backend/app/agents/api.py:119-125`).
3. Runtime ставит Bearer token в WebSocket handshake и ограничивает endpoint до `wss://`, разрешая `ws://` только loopback (`apps/runtime/src/channel.rs:241-290`). Token не помещается в URL.
4. Run claim/heartbeat/cancel/event требуют project grant, device binding, lease и проверку состояния (`backend/app/agents/api.py:152-184`). Credential lease проверяет device, run, grant, isolation validation, expiry и policy (`backend/app/agents/api.py:57-74`).

Это достаточное evidence для заявленного authenticated channel seam на уровне текущего прототипа. Границы, которые ещё нужно зафиксировать до production:

- обычные `heartbeat`, `metadata_batch` и run messages отправляются как JSON внутри bearer-authenticated WebSocket; Ed25519 signed request/replay path проверяется отдельными protocol tests и используется для attestation, но из текущего `channel.rs:84-115` и `:167-204` не следует, что каждое обычное сообщение имеет отдельную подпись и replay protection;
- runtime reconnects с тем же access token (`apps/runtime/src/channel.rs:241-282`); refresh/re-enrollment lifecycle для истёкшего token отдельно не реализован;
- OpenAPI не знает о WebSocket security scheme или message schema, поэтому REST/OpenAPI не является полным contract для runtime channel;
- нет evidence лимитов размера JSON, rate limit, per-message correlation/sequence, backpressure или bounded queue на WebSocket. Эти limits нужны до приема remote snippets/status at scale.

## 2. Offline persistence and sync

Документы задают правильную последовательность: local transaction + outbox, idempotent push, server version check, ordered pull, durable cursor (`docs/SYNC_PROTOCOL.md:14-25`, `:44-50`). Backend sync package реализует opaque cursor, owner/device binding, compaction reset, per-operation idempotency и privacy validation; тесты в `backend/tests/sync/test_sync_engine.py:166-257` покрывают retry, version conflict, cursor boundary, tombstone, reset, revoked device, transcript/secret rejection and payload bounds.

Runtime local SQLite действительно содержит local session/message/FTS tables и metadata outbox (`apps/runtime/src/db.rs:40-84`, `:116-210`). В checkout появился reusable `IndexedDbOfflineStore` и outbox-aware `ApiClient` (`packages/shared/src/offline.ts:59-148`, `packages/shared/src/api-client.ts:130-200`), а tests проверяют bearer/idempotency, cache and no-token outbox behavior (`packages/shared/tests/api-client.test.ts:25-64`). Web shell теперь получает transport через shared client (`apps/web/src/lib/api.ts`); native SQLite adapter прямо оставлен follow-up (`apps/mobile/src-tauri/src/lib.rs:10-16`), и нет evidence crash/restart or cross-device integration. Поэтому acceptance claims про offline create/edit across all clients, crash-safe client outbox и cross-device recovery (`docs/SYNC_PROTOCOL.md:86-95`, `docs/ACCEPTANCE_TESTS.md:14-21`) ещё не подтверждены.

Есть также contract gap: `docs/API_CONTRACTS.md:3,8-9` говорит, что все writes требуют authorization и idempotency, но обычные domain handlers принимают typed/dict bodies без общего `Idempotency-Key`/ETag/version precondition (`backend/app/domains/api.py:91-186`, `:189-257`). Специализированные sync/agent/AI paths имеют отдельную idempotency логику, но это не доказывает единый write contract для Notes, Tasks, Calendar, Mail и остальных CRUD операций.

## 3. Policy engine and fail-closed vendor execution

Сильные стороны текущего evidence:

- `IsolationGate::authorize_run` разрешает выполнение только для `Validated` (`apps/runtime/src/isolation.rs:61-71`);
- `MacOsIsolationValidator::validate()` намеренно возвращает `Unavailable` до validation spike (`apps/runtime/src/isolation.rs:75-85`);
- runner проверяет isolation before claim/execute (`apps/runtime/src/runner.rs:68-103`), а credential path требует signed scoped lease (`apps/runtime/src/runner.rs:119-170`, `apps/runtime/src/credentials.rs`);
- adapter capability probe не объявляет discovery/resume/run без подтверждённой совместимости; tests проверяют `can_run == false` (`apps/runtime/tests/runtime_contracts.rs:186-193`, `:471-520`);
- process layer использует bounded argv, scrubbed environment и process-tree cancellation (`apps/runtime/src/process.rs:1-97`, `apps/runtime/tests/runtime_contracts.rs:413-469`).

Ограничение: тест `validated_isolation_gate()` вручную создаёт полностью положительный `IsolationValidationReport` (`apps/runtime/tests/runtime_contracts.rs:96-104`) для проверки state machine. Это валидирует переходы, но не доказывает, что macOS Seatbelt, helper signing, entitlements и provenance реально обеспечивают заявленные свойства на установленном bundle. `apps/runtime/README.md:19-21,45-52` сам требует реальную OS-level validation suite.

### Scope gap в runtime channel

`metadata_batch` проверяет owner проекта и device ID (`backend/app/agents/api.py:126-151`), но не проверяет действующий `ProjectGrant`, policy scope или isolation grant для указанного project. HTTP `GET /agents/sessions` и `POST /agents/sessions/search` фильтруют только по owner/project (`backend/app/agents/api.py:211-220`). Это слабее заявленного правила «server verifies owner, Mac device, project/tool scope» (`docs/AGENT_RUNTIME.md:38-50`) и модели «explicit project/tool grants» (`docs/ARCHITECTURE.md:60-66`).

Без исправления этой boundary подключённый Mac device может публиковать/получать session metadata across owner projects, если знает их IDs. Это не раскрывает raw transcript само по себе, но нарушает project isolation и может загрязнить cloud index. До закрытия этого gap session metadata/search должны считаться restricted prototype path.

### Remote search and event delivery are not end-to-end

Документы требуют live query через Mac Runtime, transient scoped snippets and explicit offline error (`docs/API_CONTRACTS.md:147-173`, `docs/AGENT_RUNTIME.md:38-50`). Фактический `POST /agents/sessions/search` всегда возвращает `MAC_OFFLINE` и перечисляет только cached metadata (`backend/app/agents/api.py:216-220`); forwarding query to a connected runtime отсутствует.

Документы также требуют status/events, cancellation and structured redacted events (`docs/AGENT_RUNTIME.md:52-67`). Фактический `GET /agents/runs/{id}/events` выдаёт единственное SSE-событие с текущим `status` (`backend/app/agents/api.py:259-265`); runtime channel принимает run state/error, но не реализует durable event stream or output delivery (`backend/app/agents/api.py:152-166`). Это блокирует acceptance scenarios E/F, даже если queue/lease state machine отдельно тестируется.

## 4. API/OpenAPI security review

`docs/openapi.json` был сгенерирован временно из `app.openapi()` с `AELYS_SECRET_KEY` и сопоставлен со snapshot. Результат: OpenAPI `3.1.0`, app version `0.1.0`, 65 paths; set of paths and methods совпал, differences отсутствуют. Это подтверждает актуальность snapshot относительно текущего FastAPI app на данном checkout.

Но generated schema имеет `components.securitySchemes = None`. Защищённые операции отображают `authorization` как optional header, потому что `current_principal` объявлен как обычная `Header(default=None)` dependency (`backend/app/core/security.py:55-68`), а не как OpenAPI HTTP bearer security dependency. Runtime enforcement требует Bearer и возвращает 401, но generated client и API review tooling могут ошибочно считать endpoint unauthenticated/optional.

Другой security lifecycle gap: `/auth/logout` только требует `current_principal` и возвращает `logged_out`, не отзывает access/refresh session (`backend/app/core/api.py:42-44`). Refresh rotation отзывает прежнюю `AuthSession` (`backend/app/core/api.py:26-40`), а device revoke меняет device state (`backend/app/core/api.py:71-78`), но logout сам по себе не выполняет заявленное invalidate credentials из `docs/SYNC_PROTOCOL.md:79-84` и не отражает полноценный session lifecycle из `docs/SECURITY.md:22-35`.

BYOK boundary также ещё не production-ready: `docs/AI_HARNESS.md:28-35` требует key material outside DB, а текущая `SecretStore` — in-memory abstraction; `AuthenticatedStreamCipher` описан как dependency-free development cipher, с production KMS/keychain injection оставленным deployment responsibility (`backend/app/ai/secrets.py:1-6`, `:22-27`, `:64-87`). Это полезный test seam, но не evidence durable encrypted secret store, rotation, crash recovery or operational key separation.

## 5. Prioritized findings and blockers

| ID | Severity | Finding | Exact evidence | Gate |
|---|---|---|---|---|
| G2-001 | P0 | Tauri 2 desktop compiles but remains a bounded shell; product integration is incomplete | `apps/desktop/src-tauri/src/lib.rs:33-40`; host `cargo check` and release `tauri build` pass; no helper/entitlements/IPC | Нельзя подтвердить macOS integration, IPC, lifecycle, Keychain и install/update |
| G2-002 | P0 | Android wrapper feasibility не проверена | `docs/DECISIONS.md:10`; `apps/mobile/README.md:3-20`; `tauri android build` stops because `gen/android` is not initialized; no Android APK evidence | Нельзя выбирать Tauri 2 или fallback Capacitor; APK/background/secure storage недоказаны |
| G2-003 | P0 | Production isolation gate не validated | `apps/runtime/src/isolation.rs:75-85` всегда `Unavailable`; positive test report synthetic | Unattended vendor execution запрещено; signed attestation нельзя считать operational evidence |
| G2-004 | P1 | Live Mac session search отсутствует | `backend/app/agents/api.py:216-220` всегда возвращает `MAC_OFFLINE` | Acceptance E и remote privacy flow не выполняются |
| G2-005 | P1 | Agent event stream урезан до snapshot status | `backend/app/agents/api.py:259-265` выдаёт одно событие; runtime channel принимает только state/error | Acceptance F progress/output/cancel visibility не закрыта |
| G2-006 | P1 | Project grant не применяется к metadata/session read path | `backend/app/agents/api.py:126-151`, `:211-220` проверяют owner/device/project, но не grant/tool scope | Нарушена заявленная project isolation boundary; cloud metadata path restricted |
| G2-007 | P1 | OpenAPI не описывает auth security; logout не revokes session | `backend/app/core/security.py:55-68`; generated schema has no `securitySchemes`; `backend/app/core/api.py:42-44` | Typed clients and credential lifecycle can diverge from runtime enforcement |
| G2-008 | P1 | Единый idempotent write contract не enforced для domain CRUD | `docs/API_CONTRACTS.md:3,8-9`; `backend/app/domains/api.py:91-257` | Offline retries for non-sync CRUD могут создавать duplicate/last-write ambiguity |
| G2-009 | P1 | Offline primitive is integrated into web transport but not across native clients | `packages/shared/src/offline.ts:59-148`; `apps/web/src/lib/api.ts`; native SQLite is follow-up | Sync protocol/shared unit tests do not prove crash recovery across real clients |
| G2-010 | P1 | BYOK storage/runtime key operations остаются abstraction | `backend/app/ai/secrets.py:22-27,64-87`; production KMS/keychain injection not wired | Нельзя заявлять production secret durability/rotation/isolation |

## 6. Safe next steps

Порядок работ, сохраняющий текущую архитектуру и fail-closed policy:

1. **Зафиксировать platform spike boundaries.** Не добавлять UI design. Описать минимальный macOS Tauri shell → Rust runtime/helper IPC, helper install/stop/uninstall, entitlements, Keychain owner, signed bundle/provenance и token refresh lifecycle. Acceptance должен запускаться на packaged app, а не только на library tests.
2. **Провести отдельный Android spike.** На reproducible toolchain установить Rust Android targets, Android CLI/Gradle и Tauri Android prerequisites; собрать минимальный APK, проверить offline store, auth refresh, background sync constraints, notifications and secure storage. Только после evidence решать ADR-006; fallback Capacitor остаётся допустимым.
3. **Закрыть channel contract.** Добавить explicit bounded message schemas, max batch/message sizes, correlation and sequence IDs, replay/reconnect semantics, token refresh, backpressure and redacted event model. Отдельно решить, где обязательна per-message device signature, а где достаточно authenticated WebSocket session.
4. **Исправить scope enforcement до live data.** Для metadata publish, session listing/search and transient snippets проверять active device/project/tool grant and owner policy. Add negative tests for a valid device addressing another authorized owner project and for revoked grants.
5. **Довести Tauri scaffolds до bounded vertical slices.** Добавить отсутствующие icons/config required for context generation, затем проверить desktop `cargo check` and Tauri dev/build on supported macOS. Для mobile сначала выполнить Android init/APK spike; host `cargo check` не считается Android validation. После этого реализовать live search/events: scoped runtime request/response, explicit `MAC_OFFLINE`, transient result retention policy, source refs, durable run event sequence, cancellation acknowledgement and reconnect resume. Не отправлять transcript в backend logs or synced payloads.
6. **Harden REST contract.** Use explicit HTTP bearer security scheme in OpenAPI, typed request/response/error models, required auth, idempotency header semantics for every write, version/ETag preconditions, payload/rate limits and real logout/session revocation. Regenerate `docs/openapi.json` and keep CI diff check.
7. **Prove offline durability end-to-end.** Add real Web/macOS/Android store tests for local transaction + outbox, kill/restart, duplicate push, cursor ack after durable apply, conflict recovery and device revoke. Existing in-memory sync tests remain useful but are not a substitute.
8. **Run real isolation/provenance spike before vendor execution.** Validate Seatbelt profile, symlink/`..`, subprocess, credential paths, network policy, process cleanup, signed runtime/probe manifest and macOS packaged binary. Keep adapters `can_run=false` and `IsolationGate::Unavailable` until all evidence is collected.

## Verification performed

The following commands were run against the checkout. They are repository/toolchain checks, not claims of successful Tauri or Android platform validation:

```text
cargo test --manifest-path apps/runtime/Cargo.toml --locked
  30 unit tests passed; 14 runtime_contracts tests passed; 0 failed; 0 ignored.

cargo fmt --manifest-path apps/runtime/Cargo.toml -- --check
  passed.

PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests
  40 passed, 2 skipped, 1 warning.

PYTHONPATH=backend .venv/bin/python -m compileall -q backend/app
.venv/bin/ruff check --select E9,F backend/app backend/tests
  all checks passed.

cargo clippy --manifest-path apps/runtime/Cargo.toml --all-targets --locked -- -D warnings
  passed.

.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs
.venv/bin/bandit -q -r backend/app -ll
  mypy: no issues found in 51 source files; bandit: no issues found.

apps/desktop/node_modules/.bin/tauri --version
apps/mobile/node_modules/.bin/tauri --version
  tauri-cli 2.12.4 for both workspace packages.

pnpm --filter @aelys/web typecheck
pnpm --filter @aelys/web test
pnpm --filter @aelys/web build
pnpm --filter @aelys/shared typecheck
pnpm --filter @aelys/shared test
  passed after explicitly approving the local esbuild build script;
  web: 6 tests passed and production build passed; shared: 6 tests passed.

pnpm --filter @aelys/desktop tauri:build
  passed and produced a release binary; this does not validate Tauri window
  launch, helper lifecycle, macOS signing/notarization, or installer behavior.

cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml
  passes on the host target after adding RGBA icons; this is not an Android
  build. `tauri android build` was attempted and stopped because generated
  Android project files are not initialized.

AELYS_SECRET_KEY=<test value> PYTHONPATH=backend .venv/bin/python -c \
  'from app.main import app; ...; print(app.openapi())'
  generated OpenAPI 3.1.0; 65 paths; path/method set matched docs/openapi.json.
```

Toolchain observations used in this audit: `rustc 1.99.1` and `cargo 1.99.1` are available; global `rustup`, `tauri`, `adb` and `sdkmanager` are not available in `PATH`, while the workspace-local Tauri CLI is `2.12.4`; Java is `21.0.11`; `xcodebuild` cannot run with the active Command Line Tools directory, while `xcrun --sdk macosx --show-sdk-version` reports `26.5`.

No code, `PLAN.md`, `PROGRESS.md`, `CLAUDE.md` or `.claude/` files were changed by this audit.
