# Owner ask/search commands in Business chats

Scope: IMPLEMENTATION_PLAN Phase 3 task 5, owner-approved extension requested
2026-11-13. Implement now; no deployment, real messages, unrelated changes or UI.

## Behavior

Owner sends `/ask what is Elasticsearch`, `/search current ...`, or `/ask` /
`/search` replying to a contact's message/selected TextQuote. Also accept `/ ask`
and plain `ask`/`search` aliases at the start (case-insensitive). Answer briefly
in the same Business private chat, from the owner's account, as a separate
message. The command stays visible. Prefer selected quote over whole reply;
explicit query is the main instruction, quoted text is untrusted context. Reply
to the contact's message when known, otherwise to the owner's command. Only
verified owner-origin messages can trigger this; no contact/bot/forward trigger.
No personal domain tools, memory or chat history enter the generation prompt.

`ask`: one normal configured BYOK completion, simple 1–3 sentence plain-text
explanation, at most 1200 characters. `search`: actual hosted provider search
using existing Claude/OpenRouter credentials, 1–2 verified provider source URLs
appended. Never claim web search if no search evidence/citations. No custom URL
fetcher, scraper, new SDK or required search server. Errors go privately to owner.

## Interfaces / ownership

- Provider worker owns ai/models.py, providers.py, execution.py, usage.py and new
  tests/test_business_command_provider.py. Add ProviderRequest.web_search bool;
  AIExecutionService.complete(..., web_search=False); ProviderResponse.sources
  tuple[str,...], search_used bool; Usage extra_cost Decimal and optional
  reported_cost Decimal; usage tracker includes fees without double charging.
  Defaults preserve all callers. Hosted Claude web_search_20250305 max_uses=2;
  OpenRouter bounded web plugin (max_results=3, explicit engine). Extract real
  citations, hosted search errors, fee accounting; no app tools in search mode.
- Parser worker owns new integrations/telegram_command_parse.py and new
  tests/test_telegram_command_parse.py. Frozen ChatCommand(kind Literal ask/search,
  query str, quote str|None). parse_chat_command(text, *, bot_username: str,
  quote: str|None=None) -> ChatCommand|None. Match explicit leading command only,
  reject wrong @bot suffix and overlong input; empty query+no quote raises
  ValueError for owner-only usage notice; quote-only query becomes bounded
  explanation question, external quoted instructions never trusted. max4096.
- Main owns new durable TelegramBusinessCommand model and migration0053 after
  0052, queue/worker module, ingestion/lifecycle/send integration, regression
  tests/docs and review. New table preserves polling cursor+enqueue atomicity;
  one integration job claimed once, no replay after restart/ambiguous delivery.
  Reuse telegram_chat.send for scoped idempotent external send and fresh rights.
  Verify source message version/deletion, active binding and permissions before
  provider and after generation; fail/suppress stale requests. Auto-reply need
  not be enabled for an owner's explicit command. Existing human activity still
  suppresses automatic secretary replies. Revoke/disconnect purges new data.

## Checks

TDD parser, real adapters with synthetic HTTP transports, and ingestion→durable
job→generation→Business send using synthetic provider/Telegram transports. Cover
selected quote, whole reply, no quote, aliases, foreign owner/contact/echo,
duplicate update, command edits/deletion, disconnect, can_reply/window/policy,
manual auto_reply off, no-source search, fee accounting, timeout/no replay and
migration upgrade/downgrade. Run relevant Telegram/provider/security tests,
Ruff/mypy/Bandit, migration checks and independent review. Copy only task diff
back to original checkout after checking baseline hashes. Preserve prior work.

## Assumptions / decisions

Separate Business send is explicitly authorized by this feature request; no
confirmation per command. Bot cannot bypass Telegram chat permissions/24h window.
BYOK/network required. Search charges count in budgets; no real provider calls
while developing. Runtime framework and permanent attachment storage stay OPEN.
Full CLI transcripts never enter this path. Existing unrelated notes/desktop
work and earlier Telegram fixes remain untouched.

## Progress

- [x] Provider support and tests
- [x] Parser support and tests
- [x] Durable dispatch, security/lifecycle and integration tests
- [x] Validation, review, documentation, original-checkout integration

Validation and rollout limits: ../../optimization/telegram-owner-commands.md. Implementation in isolated checkout, verified and transferred to original without overwriting concurrent work. No deployment/live messages/commits.
