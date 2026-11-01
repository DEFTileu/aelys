# Personal OS bot — implementation and acceptance report

Date: 2026-11-01. Milestone: Phase 3, Telegram commands and verified binding.
Branch: `feat/personal-os-bot`, isolated worktree from local main `40f822e`.
Owner instructions require stages 0–7 in order, each validated and committed
before the next begins. This report is an in-progress ledger, not acceptance.
No push, PR, main modification, Railway deployment or MySDU modification.

## Owner decisions and scope

Approved on 2026-11-01: unified domain sync change-log; Telegram reminders and
quiet hours; personal AI dialogue; ephemeral voice/photo/PDF/text processing;
explicit encrypted lexical memory; task matrix/work timestamps; Google Calendar
read-only import. Existing AI runtime and Policy Engine are reused.

No MCP, RAG, embeddings, document search, attachment storage, Business media,
secretary facts beyond /busy, rolling summary, tool shortlist, group chat or
MySDU import. Sheets monitor stays in MySDU. Web UI copy is English; bot owner
replies Russian. Attachments storage remains OPEN. No credentials are assumed.
Business context must never include personal memory/tasks/notes/calendar.

## Stage ledger

| Stage | Status | Evidence / remaining work |
|---|---|---|
| 0 — merge origin/main | Accepted locally | Fetched origin/main `378ecb3`; merging into feature branch. Automation capture and rule drafts retained; contract additions retained; UI resolved by Luna medium; migration regression by Terra medium. Merge revision 0028 joins both heads without changing historical revisions. All CI commands passed locally, details below. |
| 1 — unified change-log | Not started | Client resource-kind and flow audit, failing reproduction, shared transactional writer and PostgreSQL commit-order tests required. |
| 2 — reminders/digest | Not started | Durable claims, quiet hours/DST, deadline options, /remind and tomorrow required. |
| 3 — personal dialogue | Not started | Encrypted durable queue, shared tool loop, bounded persistent conversation and /new required. |
| 4 — ephemeral media | Not started | Limits, in-memory transport, separate transcription key, capabilities/adapters and read-only file turns required. |
| 5 — explicit memory | Not started | Encrypted facts, commands/tools/API/settings, lexical selection, export/rotation required. |
| 6 — task matrix/time | Not started | Server timestamps/history, matrix and stagnant digest required. |
| 7 — Google Calendar | Not started | Read-only OAuth/PKCE/state, incremental import/disconnect, external event protections required. |

## Validation

New worktree .venv and `pnpm install --frozen-lockfile` completed. The merge
combines local main 40f822e and fetched origin/main 378ecb3 (11/18 divergent
commits). Automation create_task still calls capture and origin's draft/run
endpoints remain. Telegram UI retains manual terminal-decision overrides and
owner-note separation; its UI copy is English (14 focused tests passed).

Stage 0 validation so far:

- shared typecheck/test: passed, 36 tests; web typecheck/test/build: passed,
  410 tests in 53 files; mobile scripts: 5 passed.
- Ruff, mypy (72 source files), Bandit, compile and pip-audit: passed;
  local editable package unavailable on PyPI is the audit's explicit skip.
  Added one missing dict[str, str] annotation in imported finance code for mypy.
- Merge regression: 3 SQLite tests passed. Test fixtures rewind real migrations
  (rather than stamp a current schema) and verify data from both parent heads.
  Independent PostgreSQL upgrades from both branch revisions preserved cursor
  and passed alembic check. PostgreSQL fresh upgrade/check: passed, one head 0028.
- PostgreSQL integration 2 passed; AI SQLite/PostgreSQL contracts 8 passed.
- Runtime tests: 30 unit + 15 contract tests passed, fmt/clippy passed. Cold
  shell-helper startup on this Mac measured 3.747s then 0.030/0.042s warm; original
  2s startup tests failed. Only helper startup/credential-scope-test waiting
  increased to 10s; process-tree termination bounds, 100ms timeout test and
  production sandbox/runner remain unchanged.
- start_local Ruff/mypy passed; tests 19 passed on repeat after CPU-heavy initial
  compilation (initial run had two fixture-start timeouts).
- native-transport fmt/test/clippy passed (33 passed, 2 local hardware probes
  ignored); android-session-store tests passed; desktop/mobile fmt/check passed.
- docker compose config and backend image build passed (local validation tag).
- OpenAPI regenerated from merged app; contains both API additions.

Full backend final rerun: **323 passed, 2 skipped**, one existing Starlette
warning (PostgreSQL-specific cases covered separately above). Desktop release
build passed (`pnpm --filter @aelys/desktop tauri:build`, 3m33s). Stage 0 is
accepted locally. No signing/notarization or installation acceptance is claimed. Initial backend run collected
unfinished merge fixtures and reported 321 passed, 2 fixture failures, 2 skipped;
those fixtures now pass narrowly, and the full run is repeated.

## Live acceptance still required

Real Telegram connection and ownership, real model JSON/tool behaviour,
transcription with a real BYOK endpoint, ephemeral photo/PDF processing with a
capable model, and Google OAuth/import require owner credentials and are not
claimed by offline tests. Local browser settings acceptance is required before
final completion. No later stage or overall goal is accepted yet.
