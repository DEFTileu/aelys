# H3 Owner Web Search Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development; implement only after owner review.

**Goal:** Let the personal Telegram assistant and Web AI chat autonomously search for current information and return provider-sourced links.
**Architecture:** Add an opt-in personal read tool with a separate, isolated provider completion; enforce per-turn search/write and budget boundaries in the shared loop. Only the two owner entry points enable it.
**Stack:** Python/FastAPI, Pydantic, existing provider adapters, pytest; existing React chat event handling.
**Spec:** Owner's H3 task in this chat; Phase 4 task 4 in `docs/IMPLEMENTATION_PLAN.md`.

## Constraints and observations

- No migration anticipated: use existing AIRun cost/tokens and transient turn state; no search history, new SDK, URL fetch, worker, UI redesign or live provider calls.
- Maintain existing OPEN/PROPOSED decisions; no Business secretary, `/ask`, `/search`, or task extraction changes. Provider support: Claude and OpenRouter only, with tool-calling capability.
- Inventory: the personal registry (`_tool_registry`, `personal_tools`, `personal_memory_tools`) has no `external_effect=True` descriptors. Other registries have external Telegram reply descriptors in `telegram_ai.py`, `telegram_chat.py` and `telegram_service.py`; do not globally enable external effects.
- Policy proposal: add one external-scope allow-list field to `PermissionContext` and one condition in `policy.py`, preserving `allow_external_effects`; grant only `web.search` in the two owner channels, never from model/web text.
- `run_tool_turn` currently totals only outer `service.complete` calls, reduces `request_budget` by that total, and invokes `on_usage` after each completion; handler-internal completions are invisible. `UsageTracker` deduplicates by UUID, so each search needs a distinct deterministic UUID and immediate cumulative accounting, including failed-evidence responses and later failures/cancellation. Charge only once.
- `service.complete(web_search=True)` reserves worst-case search fee before calling the adapter; actual usage includes Claude server-tool charges or OpenRouter reported/fallback charge. Pass the remaining turn/month budget, accounting for already spent outer and search calls; persist through existing `on_usage` to the same AIRun before further waits.
- Web events: `tool_meta` supplies fallback label `Web search` and no source for an unmapped tool; `useAi.tsx` ignores unknown source IDs and displays the label without an icon, including replay via `savedSteps`. Show `Поиск в вебе: <query>` to the owner in both channels; never persist or emit the web result as a tool event.
- Assumptions for review: search counts on attempted authorized invocations, including failures; deny writes from the first search invocation onward, including later calls in the same batch, regardless of search success. Existing explicit owner permissions are unchanged.
- OPEN: SDK/framework ADR-022, external automation ADR-023 and attachment persistence remain open. H3 authorizes this bounded search only; do not update the decision register as if broader egress were approved.
- Residual injection risk: the write barrier lasts only for this turn. Web-derived text in a saved assistant answer can re-enter the next turn's context, where writes are again allowed; addressing cross-turn taint is outside H3 and must be stated in the final report.
- After a web search, hide `http://` and `https://` URLs not in provider sources in streamed and final answers; remove URLs from the search summary sent to the model, and append at most five sources. Bare domains are not filtered and remain a residual limitation.
- Scope classification tests must cover every scope in the personal registry, including `web.search`; adding an unclassified scope fails the test. Denied calls never emit `ai.tool.approved`.
- Web chat offers search only when the owner enables the per-conversation source switch, off by default. Search has a two-per-turn limit and monthly budget. The fixed search surcharge does not alone represent the full token-inclusive cost.

## Task 1: Tool isolation, policy and budget (one vertical slice)

**Files:** `backend/app/ai/{models,policy,turn,personal_tools}.py`; new focused search module if needed; `backend/tests/ai_automation/test_shared_tool_turn.py` and new focused tests. Touch `execution.py` or `tools.py` only if demonstrably necessary.

- [ ] Write deterministic failing tests for isolated `(fixed system, query)` messages, `tools=()`, `web_search=True`, 1–300 character query, at most two calls, unique usage IDs, and Claude/OpenRouter only.
- [ ] Write failing tests for missing `search_used` or structured `sources`, provider failure, exhausted request/monthly budget, successful and unsuccessful evidence charges, cancellation and duplicate call IDs; no invented source links.
- [ ] Implement opt-in registration, typed arguments, bounded untrusted text and structured URLs; use the existing provider URL filtering. Show the query in owner-visible tool events; keep returned web text and URLs out of persistent tool events/logs.
- [ ] Add narrowly scoped external authorization and enforce the write barrier by descriptor/scope before invocation; include task, note, event, reminder, remember and forget writes, same-batch ordering and all subsequent steps. Return `POLICY_DENIED` as a tool result, without granting scopes or terminating the run. Return the third-search refusal as a tool result too, letting the model deliver findings and ask the owner to repeat the deferred write.
- [ ] Extend shared turn accounting so search cost/tokens join the outer completion totals and durable `on_usage` before evidence validation; reduce subsequent budgets and prevent double charge. Preserve existing policy error handling and idempotency.
- [ ] Run focused tests red then green; verify no tests or Business code were changed to accommodate the feature.

## Task 2: Owner channels, citations and regression coverage

**Files:** `backend/app/integrations/telegram_personal_dialogue.py`, `backend/app/ai/{api,chat_support,turn}.py`; `backend/tests/test_telegram_personal_dialogue.py`, `backend/tests/ai_automation/test_ai_api.py`, `apps/web/src/tests/ai-chat-design.test.tsx` as needed.

- [ ] Write synthetic-provider end-to-end tests for both channels: question → tool → final answer with URLs appended by server from validated `response.sources`, never model-extracted links; persist/display the same answer and test streamed output/replay.
- [ ] Enable search and its tool loop only when the conversation switch is on and the provider/model is supported; preserve media, Knowledge and existing authorization behavior. Search sub-call contains none of these contexts.
- [ ] Test malicious RU/KK/EN web results requesting task/note/reminder/memory writes or secrets: no writes, action proposals or new scopes; cover same completion batch, failed search and next step.
- [ ] Test live and saved Web events and owner-visible `Поиск в вебе: <query>` in both channels; verify web results are absent from persisted tool events. Validate no third search, overlong query, unsupported provider, or budget-exhausted provider call.
- [ ] Test “search and set a reminder”: after a denied write or third search the run continues, delivers source links and asks to repeat the deferred request; no write occurs.
- [ ] Run existing Business secretary, command and task-extraction tests unchanged; run relevant Web chat tests. Keep owner-facing budget/search errors understandable.

## Task 3: Verification and handoff

- [ ] Run `PYTHONPATH=backend .venv/bin/pytest -q backend/tests` and relevant Web tests; report exact pass/fail/skip counts, including PostgreSQL-only skips.
- [ ] Run `.venv/bin/ruff check backend/app backend/tests`, `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`, `.venv/bin/bandit -q -r backend/app -ll`.
- [ ] Inspect full diff, stage explicit files only, and create atomic Conventional Commits with passing tests and security checks; no deploy, push, or live provider request. Report commits, counts, the explicit cross-turn injection risk and unverified behavior.
