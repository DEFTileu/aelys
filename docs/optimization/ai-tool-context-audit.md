# AI tool context audit — 2026-11-25

Scope: IMPLEMENTATION_PLAN Phase 4 / task 3 only. Owner requested actual LLM tool
inventory and targeted context/prompt corrections. Worktree started at 455a05d;
clean branch fast-forwarded to requested origin/main c57cf96 before implementation.
No decisions marked OPEN/PROPOSED were promoted; no UI, SDK, migration, scope or deployment change.

See [full registry, schemas, channel visibility and limits](../AI_TOOL_INVENTORY.md).

## Root causes and changes

- Baseline guest prompt reconstructed directly from c57cf96 AST: timezone present,
  Current owner time/date absent (assertion reproduced without provider call).
- Trusted server time fragment now shared across owner chat, personal Telegram,
  guest and Companion voice. Exact yesterday bounds for Almaty and DST covered.
  Invalid timezone falls back to UTC; app additionally uses owner settings fallback.
- list_tasks retains legacy query/limit/ordering, adds typed status/date bounds,
  bounded offset pagination and real creation/start/completion metadata. No fabricated
  historical state or missing timestamp. Old tasks no longer obscure a filtered day.
- Prompt requires source evidence, distinction between creation/deadline/completion,
  explicit partial-result handling. Guest privacy policy remains independent.
- No-tool Telegram/media prompt no longer advertises write access.
- App write descriptor now agrees with proposal handler: approval required before execution.
- AI_HARNESS original design catalogue clearly separated from actual registrations.
  No silently expanded personal Telegram knowledge permission.

## Validation

Tests use fake providers and SQLite owner/deleted rows; no real model or Telegram sends.
Environment reused read-only Python/test binaries, with PYTHONDONTWRITEBYTECODE=1 and
pytest cache disabled. Source workspace/main checkout was not modified.

Commands (from worktree root):

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend /tmp/aelys-status-emoji-venv/bin/python -m pytest -q -p no:cacheprovider backend/tests/test_ai_time_context.py backend/tests/test_personal_tools.py backend/tests/test_telegram_guest.py backend/tests/test_telegram_personal_dialogue.py backend/tests/test_companion_voice.py backend/tests/ai_automation backend/tests/test_ai_voice.py backend/tests/test_read_chat_history.py backend/tests/test_telegram_memory.py
/Users/tileuzhan/vsCode/aelys/.venv/bin/ruff check --no-cache backend/app backend/tests
/Users/tileuzhan/vsCode/aelys/.venv/bin/mypy --cache-dir=/tmp/aelys-tool-audit-mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs
```

Ruff: passed (three import-order findings fixed). Mypy: passed, 156 source files.
OpenAPI generated in memory using app.openapi() and compared to docs/openapi.json:
exact equality, no generated contract update required.

Intermediate run: 498 passed / 121 skipped. Expanded run initially had two DST fixture
failures because directly inserted SQLite datetimes were not UTC-normalized; fixtures
corrected to match the domain UTC storage contract. Final results recorded below.

## Limits / follow-up

No live provider semantic evaluation: deterministic tests prove context, schema serialization,
policy and tool loop behavior, not that every model will choose the right interpretation.
PostgreSQL-specific tests require their existing opt-in environment; skipped tests are not
claimed as passing. No hardware/production acceptance. No push/merge/deploy.

Historical open-state queries, full completion history and recurring-task occurrence expansion
remain unsupported by list_tasks and are stated in the model contract. Pagination is bounded,
not a transaction snapshot. Datetimes use configured server clock and IANA tzdata.

Temporary path created: /tmp/aelys-tool-audit-mypy (removed after validation).
Pytest temporary directories use pytest’s own retention; their shared parent and other runs
were not removed because ownership of earlier directories is not unambiguous.
No shared environment or cache was deleted.

Final expanded run: **548 passed, 121 skipped**, 44.00s. Existing pytest-asyncio
fixture-loop deprecation and Starlette/httpx deprecation warnings only.
After the final no-tool prompt correction, affected channel tests re-run:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend /tmp/aelys-status-emoji-venv/bin/python -m pytest -q -p no:cacheprovider --basetemp=/tmp/aelys-tool-audit-final-tests backend/tests/test_ai_time_context.py backend/tests/test_telegram_personal_dialogue.py backend/tests/test_companion_voice.py backend/tests/ai_automation/test_ai_chat_design.py
```

Result: **60 passed**, 8.90s. Ruff and mypy passed again after that correction.
The explicit final basetemp and mypy cache were removed after checks.
Next task: independent review/integration by parent; live model/Telegram validation only
under separate authorization. No remaining implementation blocker.
