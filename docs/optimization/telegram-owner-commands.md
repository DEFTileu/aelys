# Telegram owner chat commands — 2026-11-13

Task: IMPLEMENTATION_PLAN Phase 3 task 5, explicit owner-approved Business-chat
extension. Previous secretary fixes are preserved as the baseline. No UI redesign,
new SDK, deployment, live provider requests or actual messages were used.

## Behavior and implementation

Verified owner-origin `/ask`, `/search`, spaced slash variants and plain leading
`ask`/`search` are parsed in private Business chats. Explicit body is the owner's
question; selected TextQuote takes precedence over full reply and remains
untrusted reference data. Quote-only commands receive a fixed explanation/search
instruction, never the quoted instructions as authority. Empty commands report
usage privately. Replies are short plain text, sent from the owner's account in
the same chat. The original command stays visible. Auto-reply can remain off.

`telegram_command_parse.py` contains the parser. `TelegramBusinessCommand` and
migration `0053_telegram_business_commands` add a durable encrypted queue, flushed
with ingestion and cursor/receipt commit. Uniqueness is connection + chat +
message under an integration. `telegram_commands.py` claims once, checks the
owner, source version, active binding, fresh Telegram permission/window, budget,
and Policy Engine. It uses no personal tools, memory, or unrelated chat history.

`/ask` uses a normal configured provider completion. `/search` uses Claude hosted
web search (max 2 uses) or OpenRouter's explicit Exa web plugin (3 results), using
the existing BYOK credential. Sources must come from actual provider result or
citation fields. Missing sources/evidence produce a private failure notice, not
a fabricated web answer. Unsafe/oversized source URLs are rejected. No arbitrary
URL fetcher or new search server is introduced.

Search fee estimates were checked against provider documentation on 2026-11-13:
[Claude search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool),
[OpenRouter plugin](https://openrouter.ai/docs/guides/features/plugins/web-search).
Search adds costs to token charges. Native search fee limits and configured token
cost estimates are checked before calling; provider-reported total takes priority
when present. These are estimates, not a guarantee against future provider price
changes or all possible token overruns.

Generation records usage without storing prompt text as AI messages. Pending
updates are polled after generation, and source validity is checked again inside
the existing `send_chat` boundary immediately before sending. Edits/deletion and
revocation suppress pending answers; command and quoted-message deletions erase
queue context. Disconnect purges the queue; key rotation includes query/quote and
owner identity. Seven-day retention applies. Send receipts are idempotent;
interrupted or ambiguous sends do not replay. Generated sends persist `outbound`
provenance before commit; normal manual sends keep `owner` provenance.

## Validation

- Parser: 31 passed; provider worker's focused provider/execution/media/security
  run: 206 passed. Both were test-first, using synthetic external transports.
- New command/parser/provider/migration/rotation suite before the final provenance
  adjustment: 82 passed. Includes a real adapter → policy/queue → Telegram send
  integration with only external I/O replaced.
- Full Telegram/provider/secretary-boundary snapshot: **552 passed, 43 skipped**.
- Existing shared-loop/security/egress/effort suite: **120 passed, 1 skipped**.
- Existing execution/media/harness/untrusted-boundary suite: **67 passed**.
- Full backend snapshot: **1441 passed, 118 skipped, 1 failed**, 180.05 seconds.
  Failure: `tests/ai_automation/test_ai_chat_design.py::test_attachments_are_validated_injected_as_untrusted_and_recorded`.
  Synthetic PDF upload returns 422 instead of 200. The same failure was already
  independently reproduced at base `266e76c` in the earlier secretary task.
  PDF code was not changed by this feature.
- Clean/incremental migration, upgrade/downgrade and Alembic schema checks passed
  in SQLite. Optional PostgreSQL test environments were not configured.
- Ruff full backend/tests/script, mypy (126 source files), Bandit, compileall and
  whitespace diff check passed. Existing pytest/Starlette deprecations remain.
- Final command + manual-send suite after atomic outbound provenance change:
  **44 passed**. Other channels use unchanged defaults.
- Original checkout final new command/parser/provider/rotation/migration run:
  **82 passed**. Ruff, mypy, Bandit and compileall also passed there.

Independent review findings were addressed: per-chat duplicate scope, current
provider fee verification, final source guard and atomic generated provenance.
No commits or staging. Prior notes/desktop/companion work remains separate.

## Rollout / limits

Run `alembic upgrade head` in the deployed backend environment, then start/restart
the updated backend. No web bundle change is required for these Telegram commands.
Provider support/key/search availability and Telegram Business rights must be
verified on a permitted live chat. Normal Business private-chat/24-hour reply
restrictions still apply; group chats and private bot `/ask` are outside this slice.
Network is required. Live acceptance and deployment are not claimed.

Suggested live acceptance: send `/ask что такое Elasticsearch`; select “Proxmox”
in a contact message and reply `/ask`; send `/search Proxmox`; confirm short output
as the owner, correct reply target and actual sources; edit/delete a pending
command and confirm no stale reply. Search terms/selected quotes leave Aelys for
the configured provider and its search service, so use only intended content.
