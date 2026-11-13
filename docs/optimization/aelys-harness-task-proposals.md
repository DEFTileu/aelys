# Shared approvals and Telegram task suggestions

Scope: Phase 4 / task 3 extension. Task 1 accepted at `41bb72f` (2026-11-13):
generic approve/reject, nullable source metadata and expiry. Task 2 approved on
2026-11-14: one opt-in Business chat, private suggestions and owner buttons.
[Plan](../superpowers/plans/2026-11-13-aelys-personal-harness.md),
[spec](../superpowers/specs/2026-11-13-aelys-personal-harness-design.md),
[operator behavior](../TELEGRAM_BUSINESS.md).

Task 1 evidence: backend 1511 passed / 147 skipped; final opted-in PostgreSQL
and API/migration focused checks 49 passed / 4 SQLite-only race skips. Ruff,
mypy, Bandit, compileall and OpenAPI comparison passed; independent review found
no important defects. The expiry-while-waiting regression failed before the fix.

Task 2 validation (2026-11-14; Python from the shared virtualenv):

- `cd backend && python -m pytest -q --tb=short`: 1580 passed, 153 skipped, one existing StarletteDeprecationWarning (360.98s). Optional external/native/PostgreSQL checks skip without their own opt-in; PostgreSQL races were run separately below.
- `python -m pytest -q backend/tests/test_telegram_task_suggestions.py backend/tests/test_telegram_task_controls.py backend/tests/test_telegram_transport.py --tb=short`: 87 passed.
- With `AELYS_TEST_AI_POSTGRES_ADMIN_URL=postgresql+asyncpg://postgres@127.0.0.1:55439/postgres`, `python -m pytest -q backend/tests/ai_automation/test_telegram_task_suggestions_postgres.py backend/tests/ai_automation/test_action_sources.py --tb=short`: 36 passed, 6 skipped (SQLite-only variants of PostgreSQL contention tests; every PostgreSQL variant ran). A disposable `postgres:16` container bound to loopback was used; the same tests are opted in by CI.
- Migration focused regression: 18 passed. PostgreSQL `test_clean_and_incremental_upgrade[postgresql]`: 1 passed on an empty temporary DB; 0056 upgrade/repeat/downgrade/re-upgrade and `alembic check` passed. Legacy versions/data retained, temporary databases dropped.
- `ruff check backend/app backend/tests`, `mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs` (131 files), `bandit -q -r backend/app -ll`, compileall, OpenAPI comparison and diff whitespace checks passed.
- Independent read-only review covered worker/invalidation and callback/transport fixes. Regressions for daily backlog, read-permission revocation, pending expiry and callback notification policy failed before their fixes, then passed.

No production rollout or real chat opt-in.
Decisions: approve never reads Telegram tables; suggestion state preserves
message version/updated_at; TTL 24 hours bounded by source retention; expire
pending proposals during connector iteration as well as button handling.

Delivery boundary: a card already handed off by the sending CAS can arrive after
concurrent off/edit/purge. Keeping locks out of network I/O requires this honest
at-most-once handoff. Its action is already stale; callback cannot create a task.
This behavior is documented and tested. Remaining live acceptance: migrate/deploy,
then opt in one owner-selected chat and check real private callbacks/model quality.


Task 2 review follow-up (2026-11-14, after b3661a0): reproduced asyncpg's 32767
argument ceiling on 33000 retained message rows. SQL-only source invalidation now
passes that regression without materializing IDs; source state and pending-action
filters remain separate, so already-sent cards are invalidated correctly.
Standalone JSON fences reuse the secretary's normalizer, with strict validation
unchanged. Status shows today's message outcomes (UTC ingestion cohort), and off
returns before worker writes/history scans. No new migration or deployment.
Validation: `cd backend && python -m pytest -q --tb=short` → 1588 passed,
155 skipped, one existing StarletteDeprecationWarning (210.25s).
`python -m pytest -q backend/tests/test_telegram_task_suggestions.py backend/tests/test_telegram_task_controls.py backend/tests/test_telegram_ai.py --tb=short` → 111 passed.
The PostgreSQL command above now returns 37 passed / 7 SQLite-only case skips,
including the 33000-row regression; all PostgreSQL variants ran. Final fixture
with erased retained content also passed separately. Ruff, mypy (132 source
files), Bandit, compileall, unchanged OpenAPI comparison and independent
read-only review passed. The temporary cluster was stopped after validation.
