# Telegram guest chat visibility

Owner-requested scope: IMPLEMENTATION_PLAN Phase 4, task 2 (AI conversation/run
orchestration). Guest dialogue should remain in Telegram and leave AI Chat's list.

`GET /api/v1/ai/conversations` excludes conversations linked to a same-owner
TelegramGuestJob. This applies to existing/new, queued/completed, pinned/renamed
invocations. Titles do not determine origin: a regular user chat named
"Telegram guest" remains visible. Personal Telegram assistant chats remain visible.

No deletion or migration: guest jobs, messages, usage, delivery, and authenticated
"How I answered" traces keep their existing data/access checks. No new Telegram
messages are sent during rollout and no historic messages are replayed.
No OPEN decision or schema change. Assumption: the durable guest-job binding is
the authoritative origin of guest conversations.

Validation (2026-11-25): regression tests failed before the fix (queued/renamed
and completed guest conversations were listed).
- `python -m pytest backend/tests/test_telegram_guest.py backend/tests/test_telegram_answer_trace.py backend/tests/test_telegram_answer_format.py backend/tests/test_telegram_turn_progress.py backend/tests/ai_automation/test_ai_chat_design.py backend/tests/test_focus_unlock.py -q`:
  154 passed, 1 skipped (PostgreSQL integration environment unavailable).
- `python -m ruff check backend/app backend/tests`: passed.
- `python -m mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`:
  passed, 150 source files.
- `python -m bandit -q -r backend/app -ll`: passed.
- `git diff --check`: passed.

Telegram delivery tests use a controlled transport; no live owner message was sent.
Client rebuild and database migration are not needed.
