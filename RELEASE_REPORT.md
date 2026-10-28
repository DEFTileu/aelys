# Aelys Goal 3 release report

**Audit date:** 2026-10-28
**Repository state:** `main`, 10 commits ahead of `origin/main` at report creation
**Decision:** **Not release-ready; production deployment remains disabled.**

This report is based on the current source tree, the Goal 1/Goal 2 handoffs,
the security/release audits, and fresh local checks. It separates verified
development evidence from platform or external-account blockers.

## Verified locally

| Area | Evidence | Result |
|---|---|---|
| Backend unit/API/sync/AI/automation | `AELYS_SECRET_KEY=... PYTHONPATH=backend .venv/bin/pytest -q -rs backend/tests` | **55 passed, 2 skipped**; the skips are PostgreSQL-only tests without a configured `AELYS_DATABASE_URL` |
| Python quality | `compileall`, Ruff, mypy, Bandit and pip-audit from CI/local records | **Pass**; the audit warning from Starlette/httpx remains non-blocking |
| Alembic | `cd backend && PYTHONPATH=. ../.venv/bin/alembic check` with a configured secret | **Pass**, no pending operations |
| OpenAPI | `make openapi` with `AELYS_SECRET_KEY`; 65 paths; HTTP bearer scheme | **Pass**; Makefile now validates a non-empty JSON snapshot before replacing the file |
| Shared client | `pnpm --filter @aelys/shared typecheck` and `test` | **Pass**, 12 tests; entity-plus-outbox atomic path and 100-operation reopen batch covered |
| Web | typecheck, Vitest, Vite production build | **Pass**, 6 tests and production assets |
| Runtime | `cargo fmt`, locked tests, Clippy | **Pass**, 30 unit + 14 runtime-contract tests |
| Tauri host compilation | desktop and mobile `cargo check` | **Pass for host targets only** |
| Desktop Tauri binary | `pnpm --filter @aelys/desktop tauri:build` | **Pass as an unbundled release binary**; not a signed `.app`/DMG/PKG |
| Backup/export primitive | encrypted owner export/restore test | **Pass**; credentials, provider secrets and raw Mac sessions are excluded |
| Local Web/API smoke | owner bootstrap/login, browser device enrollment, project read/create, sync status | **Pass** on local SQLite with Vite `/api` proxy |

## MVP audit status

The approved MVP is not fully accepted. The following items remain partial,
unverified or blocked:

- Cross-device offline create/edit, crash/restart recovery and 100-operation
  stress testing: **partial/unverified**. The web/shared client now has a tested
  IndexedDB entity-plus-outbox transaction and ModuleView uses it for offline
  project, note and task creates; a 100-operation reopen batch passes. Native
  SQLite client storage, kill/restart during sync and full cross-device recovery
  remain a spike.
- Finance transfer integrity and timer pause/sleep conflict semantics:
  **unverified**.
- Gmail OAuth and Telegram Bot API: **blocked by OPEN product/integration
  decisions and absent credentials**. Local mail import/drafts remain
  available; no live integration is claimed.
- AI typed tool execution from the mounted API, prompt-injection end-to-end
  tests and local-session egress policy: **partial/unverified**. A bounded
  server-registered task/note tool loop now validates, authorizes and executes
  provider tool calls; its policy is conversation-scoped and cannot be expanded
  by a run. Broader tool coverage, prompt-injection E2E and durable usage
  budget accounting remain open. Redacted SSE events now persist with sequence
  IDs and support terminal replay/`Last-Event-ID` recovery. Mounted runs fail
  closed when persisted monthly budget is exhausted; concurrent reservation
  accounting remains open.
- Claude Code/Codex authenticated execution: **blocked intentionally**.
  Version/help probes pass, but adapters remain `can_run=false` until
  credentialed compatibility and trusted macOS isolation/provenance evidence
  pass.
- Live Mac session search and remote event streaming: **blocked**. The API
  correctly returns `MAC_OFFLINE`/metadata-only behavior where live forwarding
  is unavailable.
- Automation: mounted actions now use strict typed actions, registered
  `ToolRegistry` handlers, owner/project validation, `ServerPolicyEngine`
  authorization, durable windowed rate-limit receipts, failed execution audit
  and owner-scoped ActivityEvent records for task/notification side effects,
  plus a database uniqueness claim for duplicate events. Full domain-service
  dispatch and retry worker orchestration remain incomplete.

## Security changes made in Goal 3

- Access and refresh tokens now carry a session binding. `current_principal`
  checks the active session, and logout revokes it. Refresh rotation remains
  one-time and device revocation remains enforced.
- Protected REST operations now advertise an HTTP bearer security scheme in
  OpenAPI.
- Agent session metadata ingestion, listing and search require an active
  owner/device/project grant. Raw session content remains excluded.
- Mounted automation dispatch rejects unregistered policies, unknown actions,
  malformed arguments and foreign project references before writes; supported
  actions use registered typed handlers and duplicate event claims are database
  constrained.
- `make openapi` writes through a temporary file and rejects empty output.
- Encrypted single-owner export/restore uses a separate operator-supplied
  `AELYS_EXPORT_KEY`; it excludes auth sessions, device credentials, provider
  secrets, project grants and raw Mac agent sessions.
- The shared client has an optional durable entity capability. Offline web
  creates persist the optimistic entity and sanitized outbox request together;
  the API client still strips caller-supplied authorization headers.
- Frontend, shared and Tauri package manifests use exact checked versions; a
  frozen pnpm install and web/shared checks pass.
- CI now runs frozen workspace install, desktop/mobile host Rust checks, and
  the unbundled desktop Tauri binary build. It still does not claim signed
  bundles or Android APK artifacts.
- Active AI SSE streams observe auth-session revocation and cancel the run;
  repeated stream readers cannot claim a queued run twice.
- Mounted AI runs bind their prompt message and request fingerprint, reject
  idempotency-key reuse with a different payload, enforce owner project
  references, execute only the server-registered task/note tool subset, and
  reject unapproved/non-HTTPS provider endpoints before any BYOK key is used;
  the selected provider is pinned to the run and HTTP redirects are disabled.
- Backend responses now include baseline `nosniff`, frame, referrer, and
  permissions security headers with regression coverage.
- BYOK provider secrets now have an authenticated delete/revoke endpoint and a
  typed shared client method; a separate `AELYS_PROVIDER_ENCRYPTION_KEY` is
  supported for operator deployments, and `rotate_provider_secrets.py` now
  re-encrypts envelopes with incremented key versions. KMS custody remains a
  deployment gate.
- AI SSE events are redacted, persisted per run with sequence IDs, and replayed
  for terminal runs or after `Last-Event-ID`.

## Platform and external blockers

### macOS

The desktop Tauri Rust code and unbundled binary compile. A distributable
release is not verified because bundling/updater artifacts are disabled, full
Xcode is unavailable, no signing identity is installed, and helper install,
uninstall, entitlements, notarization and update flow are absent. macOS signing
and notarization remain release gates; vendor execution stays fail-closed.

### Android

The Tauri mobile host crate compiles, but `tauri android init` cannot complete
with the available Android command-line setup and no `gen/android` project or
APK exists. `adb`, `sdkmanager`, Android targets, offline storage,
notifications and background-sync behavior are therefore unverified. ADR-006
remains a spike, not a selected production wrapper.

### PostgreSQL

SQLite tests and Alembic checks pass. PostgreSQL integration requires a running
PostgreSQL service. A fresh temporary Docker PostgreSQL database on
`127.0.0.1:55432` passed Alembic upgrade/check through 0014 and both
`test_postgres_integration.py` tests. The default suite still reports two skips
when `AELYS_DATABASE_URL` is absent.

### Vendor credentials and trust

No provider credentials, Apple signing certificate, notarization account,
Android signing key, Gmail OAuth client, or Telegram Bot API credentials are
stored in the repository or assumed locally. Their absence is recorded rather
than bypassed.

## Remaining release work

1. Add a documented PostgreSQL backup/restore drill and repeat it on the
   supported deployment topology.
2. Exercise the durable client entity store through kill/restart, conflict and
   cross-device E2E tests; implement native SQLite storage where required.
3. Expand mounted AI typed tool/policy coverage and concurrent durable usage
   reservations; add the remaining automation domain-service/retry worker
   integration.
4. Perform the supported macOS isolation/helper/signing spike; only then
   consider enabling vendor execution.
5. Initialize and validate Android Tauri on a machine with the required SDK,
   NDK, Gradle, Rust targets and device/emulator.
6. Decide and implement approved Telegram/Gmail scope.
7. Finalize Apache-2.0 ownership metadata and add a tag-driven artifact,
   checksum and release workflow after signing prerequisites exist.

See [docs/GOAL3_SECURITY_AUDIT.md](docs/GOAL3_SECURITY_AUDIT.md),
[docs/GOAL3_RELEASE_AUDIT.md](docs/GOAL3_RELEASE_AUDIT.md),
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md), and
[docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) for the detailed evidence and
operator procedures.

The checked-in `backend/Dockerfile` and `compose.self-hosted.yaml` provide a
local containerized backend/PostgreSQL path with secrets supplied from the
environment; `docker compose config` and a local `docker build` pass. They do
not claim production TLS, reverse proxy, process
supervision, signing, or deployment readiness.
The CI workflow now repeats the Compose config and image build smoke checks.
The image uses the checked-in `backend/uv.lock` with `uv sync --frozen`.
An ephemeral Compose smoke also passed PostgreSQL health, backend migration,
`/healthz`, and `/docs`; its database volume was removed after the check.
