# Shared action service — Task 1 work notes, 2026-11-13

Task: IMPLEMENTATION_PLAN Phase4/task3 extension, approved by owner after planv3 review.
Task1 only: generic action approval/rejection service, nullable source metadata,
atomic expiry enforcement and backwards-compatible API. Task2 worker/buttons not implemented.

Ruling: approve never reads or locks source/integration rows. Invalidation and
approval race through conditional pending updates on the same action row; the
Task2 invalidator stores failed/ACTION_SOURCE_STALE. This keeps actions.py
independent from Telegram and avoids source/action lock-order coupling.
Ruling: new suggestion TTL24hours (bounded earlier by source retention); legacy
NULL expires_at has no automatic expiry. Task1 stores nullable metadata only.
Ruling: future task_suggestion_state writes never increment message.version.

Validation results are recorded below. No production migration/deployment or real messages in scope.

Implementation: endpoints delegate to ai/actions.py for all six write tools;
nullable metadata migrates via 0055. Source-less legacy actions retain unlimited
expiry. The service serializes pending transitions using only the AIAction row,
executes through the existing registry/Policy Engine, and commits domain change,
sync and receipt together. Failure rolls back partial domain/sync writes before
recording a conditional failed receipt. Public response shape is unchanged.

Expiry regression: a PostgreSQL approval blocked beyond expires_at initially
returned approved (RED); checking the clock after CAS acquires the row lock now
returns failed/ACTION_EXPIRED without executing the handler (GREEN). The claimed
approved state is not visible outside its transaction before the expiry check.

Validation (2026-11-13; shared Python virtualenv, commands from repo root unless
stated otherwise):

- Baseline `python -m pytest -q backend/tests/ai_automation/test_ai_chat_design.py
  backend/tests/test_telegram_personal.py`: 38 passed.
- `cd backend && python -m pytest -q --tb=short`: 1511 passed, 147 skipped,
  one existing StarletteDeprecationWarning (174.85s). Optional PostgreSQL,
  native/runtime and external-service fixtures skip without explicit opt-in.
- Final focused `AELYS_TEST_AI_POSTGRES_ADMIN_URL=postgresql+asyncpg://postgres@127.0.0.1:55439/postgres
  python -m pytest -q backend/tests/ai_automation/test_action_sources.py
  backend/tests/ai_automation/test_ai_chat_design.py
  backend/tests/test_ai_action_source_migration.py --tb=short`:
  49 passed, 4 skipped. These four skips are SQLite variants of PostgreSQL-only
  contention tests; all PostgreSQL race variants ran. Includes the final added
  create_event and unavailable-project coverage after the full-suite collection.
- PostgreSQL API/event/action regression: `python -m pytest
  tests/ai_automation/test_action_sources.py tests/ai_automation/test_ai_api.py
  tests/ai_automation/test_ai_event_commit.py -q --tb=short` from backend with
  the same admin opt-in: 40 passed, 4 skipped (before the last two added cases).
- Migration/connector regression and PostgreSQL clean-chain/check: 18 passed;
  `python -m pytest -q backend/tests/test_ai_action_source_migration.py
  backend/tests/test_telegram_command_migration.py
  backend/tests/test_telegram_chat_migration.py
  backend/tests/test_telegram_knowledge_merge_migration.py
  backend/tests/test_telegram_owner_identity.py
  backend/tests/test_telegram_session_migration.py
  'backend/tests/test_clean_migrations.py::test_clean_and_incremental_upgrade[postgresql]'`,
  with `AELYS_TEST_POSTGRES_MIGRATION_URL` pointing at the disposable local cluster.
  No production database was touched.
- `ruff check backend/app backend/tests`: passed.
- `mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`:
  passed, 129 source files.
- `bandit -q -r backend/app -ll`: passed.
- `python -m compileall -q backend/app`, generated OpenAPI comparison against
  docs/openapi.json, and `git diff --check`: passed.

CI now explicitly includes action source/expiry race tests in the opted-in
PostgreSQL job. Task 2 worker, source invalidation hooks, callbacks and Telegram
private buttons remain unimplemented; their absence prevents releasing suggestions.
Next task: Task 2 only after its own end-to-end implementation and verification.

Final independent read-only review found no important defects in Task 1.
Ruling: review of extraction/invalidation/callback owner binding is deferred to
Task 2 because these paths do not exist yet; no suggestion release is claimed.
No other deviations or deferred review findings.
