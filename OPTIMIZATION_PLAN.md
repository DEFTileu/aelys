# Aelys optimization plan — active, 2026-10-30

Authority: owner asked for autonomous work while asleep, including the complete
`docs/goals/OPTIMIZE_ALL_PLATFORMS.md` goal and later incremental improvements.
Follow AGENTS.md; no publishing/deployment, production data reset, new external
side effects or relaxation of sandbox/auth. UI requirements stay unchanged.
One validated slice at a time within the Phase 8 hardening milestone; dependencies
may require bounded fixes in the existing Phase 1–7 modules.

1. **Baseline (active):** capture exact current code/toolchain, synthetic API
   p50/p95/query count/peak Python memory, web chunk/gzip, platform prerequisites.
   Initial web asset: ~446kB JS / ~130kB gzip, all module imports eager.
2. **Web startup:** lazy route chunks and meaningful route-loading tests while
   preserving the owner gate and shell. Owner: frontend worker, App.tsx/new tests.
3. **Backend/data:** real SQLite and disposable PostgreSQL baseline; address
   measured reads/queries/memory with contracts and regression tests. Parent owns
   API benchmark and backend changes initially. Never use the personal DB for seed.
4. **macOS:** build actual local unsigned .app, verify launch, API/auth compatibility,
   repeatable startup/idle RSS/CPU measurements. Desktop worker owns apps/desktop.
5. **Android:** verify installed Android Studio/JDK21/SDK, resolve missing tools
   safely, initialize existing Tauri spike, build real APK and verify emulator
   scenarios if available. Android worker owns apps/mobile. No silent license
   acceptance or wrapper decision.
6. **Cross-platform connectivity/sync:** integrate platform findings, validate
   durable data/session behavior and retain fail-closed agent execution. Cache
   and outbox fixes require proof of safe replay; no automatic legacy POST replay.
7. **Verification/report:** compare same benchmark scenarios, web browser checks,
   backend/shared/web/Rust quality gates, migrations/OpenAPI, real platform artifacts
   and SHA256. Missing gates remain explicit, not counted as completed.
8. **Follow-through:** after this complete goal, choose the next actual defect
   from evidence and implement separately. Hourly thread heartbeat continues the
   current goal without spawning a competing lead or repeating unchanged updates.

Existing working tree is heavily modified from prior tasks; preserve all such
work. Main app continues on 127.0.0.1:5173 and backend on :8000. Test instances
must have distinct hostname/context and isolated DB to avoid cookie interference.

## Initial findings (historical)

Their current resolution status is in the continuation checkpoint below.

- Initial JS is now split; verified raw/gzip reduction is recorded in report.
- Search unnecessarily transferred 2000 large note bodies + 2000 mail bodies;
  projection reduces Python peak allocation by ~85%, with unchanged result shape.
  The same search also exposed tombstoned records; regression test covers this.
- Fresh PostgreSQL migrations fail independently of query benchmarks. Treat this
  as P1 release reliability; fix before claiming native/self-host readiness.
- Native shells default to relative API URLs and browser cookie sessions that
  cannot function as bundled cross-origin WebViews. Resolve with a tested native
  transport/session boundary, not wildcard CORS or unsafe certificate exceptions.
- Android SDK agreement needs the owner; avoid repeated retries while unchanged.

## Continuation checkpoint

Current evidence is authoritative in `OPTIMIZATION_REPORT.md`; historical
slice details remain in `docs/optimization/`. Completed work must not be
reselected from superseded continuation notes.

Verified slices: SQLite/PostgreSQL synthetic benchmarks; search projection and
tombstones; clean migration repairs; route splitting; durable cache key,
confirmed-write invalidation and owner/origin partition fixes; note draft/version
handling; local launcher supervision; bounded typed native module operations;
native incremental AI Channel delivery and cancellation; provider HTTP-stage
cancellation, durable polling and SQLite SSE transaction fixes. PostgreSQL now
also has four fresh-migration AI cancellation/revocation/terminal-delivery cases.
The configured full backend suite passes 197 tests / 3 skips; full Ruff, mypy
and Bandit also pass. See
`docs/optimization/backend-quality-gate.md` for the latest quality slice and
`docs/optimization/postgres-ai-contracts.md` for the PostgreSQL scenarios.

The overall goal remains incomplete. Remaining acceptance must be derived from
`docs/goals/OPTIMIZE_ALL_PLATFORMS.md`, not inferred from these passing slices:

- macOS: owner-authenticated native Keychain persistence/restart and sleep/wake,
  credentialed module/integration behavior, and the existing isolation gates.
  The unsigned `.app` build is not proof of those scenarios.
- Android: SDK/NDK installation and actual arm64 debug/release APK builds now pass;
  exact artifacts and packaging fix are in `docs/optimization/android-apk-build.md`.
  Next: HTTPS backend login/CRUD, Keystore persistence/invalidation and USB phone
  lifecycle acceptance. The owner connected the physical phone. Keep ADR-006
  PROPOSED; build success does not prove usable Android modules.
- Review remaining browser/offline/sync/performance requirements against current
  artifacts before claiming all-platform completion. Live credentials must not
  be replaced with mock integration acceptance.

Main services remain `127.0.0.1:8000` and web `5173` (also `5174`). The current
backend PID and native artifact identity are recorded in the report. Do not
restart or rebuild unchanged components solely to repeat a prior check.
The only task-owned PostgreSQL container is `aelys-optimization-pg`, loopback
port 55436, with synthetic data. New PostgreSQL AI fixtures create/drop only
UUID-named databases they themselves created. Do not operate unrelated Docker
containers or use the personal database for seed/reset/acceptance fixtures.

Latest browser reliability slice: Notes no longer reports an old save as success
for a newer draft or another selected note. 169 web tests, typecheck/build and
isolated production-browser offline/delayed-real-save/reload checks pass; see
`docs/optimization/note-save-notices.md`.
