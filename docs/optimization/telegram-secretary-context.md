# Business secretary context repair — 2026-11-13

Task: IMPLEMENTATION_PLAN Phase 3, task 5. Owner reported that the Business bot
addressed the owner as the contact and requested a screenshot already supplied.
Owner authorized reuse of MySDU prompts and Luna subagents; four `gpt-6-luna`
agents implemented identity/prompt/web work and independently reviewed integration.

## Changes

- `backend/app/integrations/telegram_secretary.py`: MySDU-derived first-person,
  audience, untrusted-context, no invented promises, no repeated photo requests,
  no_reply/handoff rules. Narrow output guard recognizes obvious owner-addressed
  openings across Latin/Kazakh/Russian spellings and intermediary voice.
- `telegram_models.py`, `telegram_service.py`, migration
  `0052_telegram_owner_identity.py`: encrypted nullable profile name from verified
  binding/BusinessConnection only; fresh connection backfills existing records;
  disconnect/bot replacement clears identity. Existing API shapes unchanged.
- `telegram_ai.py`: separate manual and automatic history, preserve attachment
  and reply-reference markers, pass up to two unanswered photos transiently to
  an image-capable configured model. Existing 10 MiB/photo, permission, download
  recheck, text budget, concurrency and no-AI-history rules remain. Unreadable
  attachments or invalid reply audience hand off to the owner without sending
  the generated text. Incurred provider usage remains recorded.
- Shared Messages eligibility now exposes photo drafts/handoffs on desktop and
  mobile. Audio retains manual preview behavior. Regression and migration tests
  cover the above. MySDU was read only; no credentials or conversations copied.

## Validation actually run

- Original checkout: `./backend/.venv/bin/python -m pytest backend/tests/test_telegram_ai.py backend/tests/test_telegram_reply_media.py backend/tests/test_telegram_owner_identity.py backend/tests/test_telegram_secretary.py -q --tb=short` — **91 passed**.
- After final prompt wording clarification: helper suite — **18 passed**.
- Identity lifecycle and token rotation after final cleanup — **14 passed**.
- Isolated checkout: backend interpreter `-m pytest tests -q --tb=short` —
  **1358 passed, 118 skipped, 1 failed** in 503.45 seconds. The failed test is
  `tests/ai_automation/test_ai_chat_design.py::test_attachments_are_validated_injected_as_untrusted_and_recorded`:
  its synthetic PDF upload returns 422, expected 200. A separate clean worktree
  at base commit `266e76c` reproduces the same failure. PDF code is unchanged.
  This full snapshot preceded the final one-line identity purge cleanup; its
  focused regression and final 91-test run passed afterward.
- Migration tests include clean/incremental SQLite upgrade, downgrade, existing
  data preservation and Alembic schema check. PostgreSQL opt-ins were not enabled.
- `pnpm --dir apps/web exec vitest run --maxWorkers=2` — **923 passed**, 96 files.
  Initial unrestricted run had 921 passing and two failures in cancellation and
  navigation plus a delayed search-mock error. The three affected/changed files
  passed **40 tests** in a one-worker recheck; bounded full rerun passed cleanly.
- `pnpm --dir apps/web typecheck` — passed, including original checkout.
- `.venv/bin/ruff check backend/app backend/tests` — passed.
- `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs` — passed, 124 files.
- `.venv/bin/bandit -q -r backend/app -ll`, backend `compileall`,
  `git diff --check` — passed.
- Independent review found no actionable integration findings. Existing pytest
  fixture-loop-scope and Starlette/httpx deprecation warnings remain.

## Limits and rollout

Source changes are present in the original checkout, unstaged/uncommitted;
unrelated notes, desktop and companion work is preserved. No push, deployment,
production migration or live Telegram/provider calls were made. Apply
`alembic upgrade head` from the deployed backend environment before starting the
updated backend, and release the updated web bundle. Live acceptance needs a
permitted chat reproducing photo → error text → owner-name summons. Attachment
storage remains OPEN; no new access to personal modules or memory was granted.

## Subsequent release verification — 2026-11-13

The earlier PDF failure came from missing declared `pypdf` in the old test
environment. It passes with the complete dependency environment, without any
PDF code changes. The final secretary + owner-command snapshot passed the full
backend suite: **1443 passed, 118 skipped** in 155.79 seconds. The changed web
test file passed **24 tests**. Owner-authorized release commits are `6bec25b`
and `d03bae6`; the earlier no-push status above describes the initial handoff.
Live Telegram/provider acceptance remains unperformed.
