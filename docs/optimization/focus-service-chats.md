# Focus service conversations

Scope: IMPLEMENTATION_PLAN Phase 4, task 2 (AI run orchestration and accounting).
Owner-requested correction: keep Focus unlock helper calls out of AI Chat.

One-shot JSON helpers create hidden conversations using the existing service-chat
soft-delete convention. AIRun usage and FocusUnlockRequest reason/decision remain
intact; `/api/v1/focus/requests` remains their owner-scoped history endpoint.
Migration 0065 hides existing empty FocusUnlock conversations, including pinned
ones. Conversations containing messages and previously deleted rows are preserved.
Downgrade deliberately does not resurrect rows, since owner deletions cannot be
distinguished safely. No API/schema contract or OPEN decision changes.

Assumption: empty legacy FocusUnlock rows are internal helper records, consistent
with their original creation path. User conversations containing messages remain
visible even with that title. Deployment requires `alembic upgrade head`; this
change does not apply migrations to a running installation.

Validation (2026-11-25):
- Regression tests failed before the fix for both newly created and legacy chats.
- `python -m pytest tests/test_focus_unlock.py tests/test_focus_service_chat_migration.py tests/test_clean_migrations.py tests/ai_automation tests/test_automation_api.py -q`
  from backend: 389 passed, 122 skipped (environment-dependent integration cases).
- `python -m ruff check backend/app backend/tests`: passed.
- `python -m mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`:
  passed, 148 source files.
- `python -m bandit -q -r backend/app -ll`: passed.
- `git diff --check`: passed.

PostgreSQL migration acceptance and deployment to the running application remain
pending. SQLite migration tests cover upgrade, schema check, downgrade/re-upgrade,
retained messages, existing deletions, accounting and Focus request data.
