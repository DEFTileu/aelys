# Telegram Guest Mode release

Scope: existing Telegram integration. Owner approved Guest Mode only for their
bound numeric Telegram identity, with web search by default. A separate trailing
`aelys` word in their own request unlocks existing personal read/write tools;
quoted text cannot grant access. Shared-chat answers may contain explicitly
requested personal information. Existing Policy Engine restrictions remain.

Owner approved merge/deployment after reviewing the implementation report,
including migration 0064_telegram_guest_jobs. Guest Mode activation in BotFather
remains an owner action. Real Telegram delivery and trace acceptance are pending.

## Integration

Gemini commit 1fd086ba was cherry-picked as 0caa4775 over main fd74e1dc,
preserving the newer answer-trace question/answer display. History part 2 was
not merged. The additive migration has a single Alembic head and creates the
encrypted durable guest job queue, deduplication constraints and run ownership.

GPT-6.1 Sol review found that native Telegram code/blockquote entities could
grant marker permissions. GPT-6.2 Sol fixed this with validated UTF-16 masking,
untrusted context separation and fail-closed malformed entity handling.
The reviewer found no remaining actionable findings in that fix.

## Validation

- Core guest/transport/trace/formatter/delivery: 125 passed, no skips after fix.
- Personal dialogue/queue/Business/commands/source regression: 219 passed;
  the initial PostgreSQL cases had 45 fixture errors because the supplied DSN
  used psycopg while those fixtures require asyncpg. Rerun with asyncpg:
  45 PostgreSQL queue cases passed, no skips (45 SQLite cases deselected).
- Guest PostgreSQL migration/claim/deduplication/trace: 2 passed before fix;
  repeated after fix before publication. Disposable PostgreSQL 16 only.
- Mini App browser suite with official SDK: 27 passed, no skips.
- Ruff on changed Python files passed; focused mypy on telegram_guest.py passed
  with explicit package bases and silent imported modules. Whole-tree typing
  is not claimed by this targeted check.
- Alembic reports one head: 0064_telegram_guest_jobs.

## Live acceptance still required

Enable Guest Mode in BotFather, then invoke from a supported chat where the bot
is absent: search without marker; explicit personal read/write with marker;
another user's invocation; owner/non-owner opening of the guest answer trace.
One guest reply is bounded to 4096 UTF-16 units. Web-search taint rules can block
writes later in the same turn; a separate explicit invocation is then needed.
