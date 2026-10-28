# Aelys Implementation Progress

Updated: 2026-10-28

## Goal 3 status — release audit in progress

- Goal 3 security and release audits are recorded in
  `docs/GOAL3_SECURITY_AUDIT.md` and `docs/GOAL3_RELEASE_AUDIT.md`.
- Release-critical local fixes now include session-bound access tokens and
  logout revocation, explicit HTTP bearer security in OpenAPI, active project
  grant checks for agent metadata/search, policy authorization on mounted
  automation actions, an atomic OpenAPI snapshot target, and encrypted
  single-owner export/restore that excludes credentials and raw Mac sessions,
  session-revoked AI SSE cancellation, strict mounted automation handlers,
  prompt-bound AI run idempotency and provider endpoint allowlisting.
- Current local evidence: backend `55 passed, 2 skipped`; runtime `44 passed`,
  format and Clippy pass; shared `12 passed` including atomic entity/outbox and
  100-operation reopen coverage;
  coverage; web `6 passed`, typecheck and
  production build pass; desktop/mobile host Rust checks pass.
- Release is still not ready. Android APK generation, macOS signing and
  notarization, distributable installer/update flow, PostgreSQL backup/restore
  against a running service, authenticated vendor execution, helper IPC,
  Telegram/Gmail external integrations, and full cross-device offline E2E are
  not verified. Security remains fail-closed where evidence is missing.

## Goal 2 status — in progress

- Documentation and Goal 1 handoff were re-read before frontend work.
- The repository now has `apps/web`, `apps/desktop`, `apps/mobile` and
  `packages/shared` workspace targets. The web production build, shared
  TypeScript check and host Rust checks for both Tauri shells pass; packaged
  platform validation is still open.
- The 13 supplied weather backgrounds are being copied as local web assets with
  a manifest. They are selected by solar period and optional weather condition;
  no remote hotlink is required.
- The supplied design reference is being implemented as a responsive photo
  hero + sidebar/rail + widget deck on desktop and launcher + AI Command Bar on
  compact screens. The mobile layout deliberately has no bottom navigation.
- The web shell uses the shared typed `ApiClient` and IndexedDB cache/entity/outbox;
  Settings exposes the real API base URL and browser-session login boundary.
  The existing macOS runtime is exposed to the desktop shell only through
  capability/status commands. Vendor invocation remains disabled and
  fail-closed.

### Goal 2 validation limits observed locally

- Global `cargo-tauri` is not installed; the workspace Tauri CLI resolves at
  version 2.12.4. `pnpm --filter @aelys/desktop tauri:build` now passes and
  produces a release binary; `tauri dev` window smoke and signed packaging are
  still unverified.
- `xcodebuild` is unavailable because the active developer directory is only
  Command Line Tools; macOS signing/notarization remain Goal 3 work.
- Android APK prerequisites are not validated: `adb`/`sdkmanager` and Rust
  Android targets are not available in PATH, and `tauri android build` stops
  because `apps/mobile/src-tauri/gen/android` is not initialized. No APK or
  notification/background-sync evidence is claimed.
- Web/shared checks now pass: web has 6 Vitest tests and a production build;
  shared has 12 API/offline tests and a typecheck, including a 100-operation
  offline reopen batch. End-to-end authenticated CRUD,
  crash/restart sync and cross-device recovery are still pending.

## Status

- Documentation review: complete. Required project, architecture, API, sync, runtime, AI, security, acceptance, and roadmap documents read.
- Repository inspection: complete. Existing repository is a documentation-first skeleton with pre-existing user changes preserved.
- Foundation: implemented and verified with async SQLite and PostgreSQL tests; hashed rotating refresh sessions, device revocation, and Alembic migrations are configured.
- Domain APIs: implemented for projects/resources, notes/revisions, tasks/calendar, finance/timer, local mail, AI settings/conversations, search/history/notifications.
- Sync engine: implemented with idempotent receipts, version conflicts, note branches, ordered pull, snapshot-bound bootstrap pagination, retained tombstones, stale-cursor reset responses, device-bound monotonic acknowledgement cursors, and private-content rejection.
- AI harness and automation: implemented with Claude/OpenRouter adapters, encrypted BYOK envelopes, capability/privacy/budget routing, Decimal usage/cost tracking, SSE, durable cancellation polling and compare-and-set terminal state, typed policy tools, and replay-safe rule dispatch.
- macOS runtime: implemented as a headless Rust crate with local SQLite/FTS, Claude and Codex JSONL session parsing, metadata allowlist, conservative adapters, explicit network grant policy, signed channel types, authenticated heartbeat/lease/run-event/credential-lease channel operations, bounded Claude/Codex help-flag compatibility probes, Seatbelt isolation profiles, six-control probes with canonical root/profile/runtime/probe digest binding, bounded sandbox process supervision, process-group cancellation/timeout, reconnect, process-tree cleanup, durable SQLite-backed run leases and restart reconciliation, adapter executable identity binding, integrated run state transitions, signed single-use credential leases, signed provenance-bearing attestation, and internally mapped Keychain credential injection. The installed Claude Code `2.1.311` and Codex CLI `0.163.0` expose the required help flags, but authenticated invocation remains disabled. The backend requires an operator-pinned Ed25519-signed runtime/probe manifest before accepting provenance; manifest verification is covered by backend tests. Local Rust tests (30 unit, 14 integration), clippy, live PostgreSQL run lifecycle, and prior live channel/attestation evidence remain recorded, with the new trust-root deployment path still requiring release configuration.
- Integration, CI, OpenAPI, and migration checks: backend verified; 55 local Python tests pass and 2 PostgreSQL-only tests skip without a configured PostgreSQL service. A fresh temporary Docker PostgreSQL database also passed Alembic upgrade/check through 0014 and both PostgreSQL integration tests. Bootstrap snapshots, PostgreSQL mounted sync integration with paged snapshot/reset and device acknowledgement coverage, PostgreSQL concurrent sync conflict behavior, durable run idempotency, owner-serialized sync pushes, repeatable-read bootstrap, refresh-token separation, fail-closed secret configuration, backend-signed credential lease issuance over HTTP and WebSocket, signed release-manifest provenance verification and generation tooling, cancel-before-start and active/durable AI stream cancellation, repeated SSE read protection with persisted event replay, prompt-bound AI idempotency, conversation-scoped bounded typed AI task/note tool execution, provider identity pinning and endpoint rejection, persisted monthly budget exhaustion fail-closed behavior, durable automation rate-limit receipts and failed execution audit, explicit SSE media types, fresh/incremental SQLite migration through 0014, live Rust-to-FastAPI heartbeat/metadata/revocation, provenance-bearing signed sandbox attestation, queued-run authorization, lease/cancellation lifecycle, sandboxed process execution, Claude JSONL parsing, and local run state transitions are verified. The installed Codex CLI also completed an ephemeral read-only `Reply with exactly OK` compatibility run. Full acceptance is not complete because vendor adapters remain conservatively disabled until a credentialed CLI compatibility run and trusted helper/code-signing provenance are available.

## Decision guardrails

The implementation will not claim Gmail OAuth, Telegram production delivery, Android support, cloud storage of agent transcripts/embeddings, or safe unattended remote execution without the corresponding approved decision and tests. Vendor autonomous execution remains disabled unless installed CLI compatibility and the credential broker are verified. Any incomplete security isolation keeps remote autonomous execution disabled.

## Test record

Backend verification: `PYTHONPATH=backend .venv/bin/pytest -q -rs backend/tests` → 55 passed, 2 PostgreSQL-only tests skip without `AELYS_DATABASE_URL`; a fresh temporary Docker PostgreSQL database passed Alembic upgrade/check through 0014 and both PostgreSQL integration tests. `compileall` passes; a fresh SQLite migration through 0014 and `alembic check` pass; OpenAPI generation produces 65 paths with explicit SSE media types. PostgreSQL mounted sync integration, paged bootstrap/reset and acknowledgement behavior, concurrent sync conflict test, durable run idempotency, backend-signed credential lease issuance, signed release-manifest provenance verification/generation, and cancellation lifecycle pass. Runtime verification: `cargo fmt --manifest-path apps/runtime/Cargo.toml -- --check`, `cargo test --manifest-path apps/runtime/Cargo.toml --locked` → 44 tests passed, host checks, and `cargo clippy --all-targets -- -D warnings` pass. Live Rust heartbeat/metadata acknowledgements, post-revocation rejection, six-control Seatbelt probe, challenge-bound provenance-bearing canonical signed attestation, queued-run authorization, lease/cancellation lifecycle, reconnect, process-tree cleanup, persisted run restart reconciliation, signed credential lease scope/replay checks, sandboxed `/bin/echo` process execution, local run transition, internally mapped Keychain provider-variable handling, scrubbed environment handling, and Claude/Codex JSONL parser behavior were verified against FastAPI/macOS; the trust-root deployment path still requires release configuration.

Multi-agent workflow used disjoint workers for AI/automation, domain APIs, sync, macOS runtime, and architecture/security review. Their scoped changes and validation were reviewed and integrated by the lead. The initial dispatcher also reported a thread-limit error, but the worker results arrived and were verified.

## Next action

Complete authenticated vendor CLI compatibility and supported macOS helper signing validation before enabling unattended vendor execution.

## Remaining prerequisites

- Goal 2: full cross-device offline/restart E2E, generated TypeScript contracts, Android wrapper spike, device UX, and approved Gmail/Telegram integration scope.
- Goal 3: production deployment and encrypted backup topology, final macOS sandbox implementation and evidence on supported macOS versions, release signing/installers, license confirmation, and optional Mac-session backup decision.

## Completion audit

- Foundation, fail-closed secret configuration, access/refresh token separation, authentication/device revocation, PostgreSQL schema, Alembic 0001–0012, mounted REST/OpenAPI contracts, domain ownership checks, sync, AI provider/BYOK paths, automation, backend-signed credential lease issuance, and local-only metadata boundaries: implemented and tested.
- Runtime session discovery/indexing, local SQLite/FTS, signed channel, digest-bound sandbox probes, lease-bound queue protocol, process supervision, cancellation, reconnect, process-tree cleanup, internal credential mapping, and cloud metadata privacy: implemented and tested.
- Vendor CLI credentialed execution and macOS helper/code-signing validation remain release gates. The backend now verifies configured signed release-manifest digests, and the runtime detects required invocation flags without enabling them. Release operations still must provision that trust root and prove the helper signing chain on supported macOS versions. The runtime stays fail-closed for vendor execution.
- CI verifies Python compilation/tests, strict application mypy checking, Ruff correctness lint, Bandit checks, pip-audit dependency scanning, database migrations, PostgreSQL integration, OpenAPI drift, and Rust format/tests/Clippy.
- Frontend/shell CI also performs frozen pnpm install, web checks, desktop and
  mobile host checks, and the unbundled desktop Tauri binary build; signed
  macOS bundles and Android APK artifacts remain platform-gated.
- `backend/Dockerfile` and `compose.self-hosted.yaml` provide a local
  containerized backend/PostgreSQL path; production TLS, reverse proxy,
  process supervision and backup operations remain operator gates.
- `.dockerignore` keeps local caches, frontend artifacts, Rust targets and
  secrets out of the backend image build context; Compose config and a local
  backend image build pass.
- An ephemeral Compose smoke passed PostgreSQL health, backend migration,
  `/healthz` and `/docs`, then removed its temporary volume.
