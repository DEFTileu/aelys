# Telegram Business / Secretary connector — 2026-10-29

Selected task: `IMPLEMENTATION_PLAN.md`, Phase 3 task 5, Telegram adapter and
verified owner binding. Owner explicitly requested reading incoming business
messages and automatic replies, and authorized up to six subagents. Four agents
worked on disjoint transport, persistence/rotation, web/shared client, and
research/AI scopes; the main agent implemented service/API/worker and integration.
Existing dirty work was preserved. Nothing was staged or committed.

## Result and scope

Implemented a real Bot API connector, not a UI-only toggle: write-only encrypted
token, fixed HTTPS transport, verified single-owner deep link, durable long-poll
cursor and lease, receipt deduplication, Business connection updates, private text
messages/edits/deletions, scoped BYOK generation and policy-checked sendMessage
with business_connection_id. A supervised FastAPI lifespan worker polls while the
backend runs; localhost does not need a public webhook. Existing webhooks are
reported and never removed automatically.

The Settings → Telegram panel separates bot configuration, owner binding and
Business connection readiness. Owner can choose provider/model, set business
instructions, enable automatic reading/reply, pause or disconnect. Incoming state
refreshes without overwriting edited response text. Manual drafts/replies remain
available. Secret input is never stored in JS storage/outbox and is cleared on
successful configuration; server validation never echoes it.

Fresh Business rights are checked before both external AI processing and sending;
reply window, owner activity, newer messages, rate limit and message version are
checked before an atomic send claim. Ambiguous results and interrupted sends stay
unknown and never automatically retry. Duplicate/concurrent workers cannot send
another copy. Telegram 429 cooldown persists. Retrying identical credentials
preserves a working connection instead of purging data.

Business text/drafts/chat labels/persona are encrypted at rest. Only same-chat
bounded history reaches the chosen AI provider; no personal Aelys modules, Mac
histories or tools are available to customers. AI audit stores usage metadata,
not business messages in AIMessage. Deletions/revocation erase cached contents;
seven-day retention and Disconnect purge are implemented. Connector tables are
excluded from owner export, sync and browser outboxes. Existing key rotation
handles the token and new encrypted fields transactionally.

Unsupported/out of scope: media/attachments, forwarded messages, group chats,
proactive campaigns, personal `/task`/`note` commands, Telegram Stars/gifts/profile
management, OS notifications, distributed deployment acceptance and unconfigured
AI. These are not claimed complete.

## Changes

- `backend/app/integrations/telegram_{models,transport,service,api,ai}.py`:
  persistence, network boundary, ingestion/claims, owner API and AI harness.
- `backend/alembic/versions/0022_telegram_business.py`, model registration,
  `app/main.py` lifespan/routes, export exclusion and provider-key rotation.
- `apps/web/src/views/TelegramSettings.tsx`, `SettingsView.tsx`:
  business setup/auto-reply UI, reachable at `/settings?section=telegram`.
- `packages/shared/src/telegram.ts`, `api-client.ts`, `index.ts`: typed contracts.
- Six backend Telegram test files and web `telegram-settings.test.tsx` cover
  transport, encrypted migration/rotation, lifecycle, identity/policy, UI and errors.
- API/data/security/decisions/integration/self-hosting docs and OpenAPI updated.

## Validation

| Command | Result |
| --- | --- |
| `PYTHONPATH=backend .venv/bin/pytest -q backend/tests` | 144 passed, 2 skipped (PostgreSQL unavailable), one existing Starlette deprecation warning |
| `pnpm --filter @aelys/web test` | 71 passed |
| `pnpm --filter @aelys/shared test` | 20 passed |
| web/shared `typecheck` | passed |
| `pnpm --filter @aelys/web build` | passed |
| Ruff `--select E9,F backend/app backend/tests` | passed |
| mypy `--explicit-package-bases --ignore-missing-imports --check-untyped-defs backend/app` | passed, 64 files |
| Bandit `-q -r backend/app -ll` | passed |
| Alembic `upgrade head` and `check` | passed, existing local DB at 0022 with no schema drift |
| `git diff --check` | passed |

Focused acceptance includes owner binding expiry/replay/private-chat checks,
foreign connections refused, encrypted storage and rotation rollback, token URL
log redaction, webhook conflict, update cursor/receipt rollback, malformed
updates, edit/delete invalidation, revoked rights, 24-hour window, pause during
generation/permission check, ambiguous send prevention, concurrent automatic
reply once, provider budget/context isolation and no tools. One combined test
runs the actual configured AI harness/router/adapter and usage audit through the
automatic reply path, replacing only external provider and Telegram transports.

Local backend/web remain running on ports 8000/5173. Browser verification opened
the actual Settings → Telegram screen and confirmed its honest unconfigured
state, setup steps and write-only token input. No synthetic Telegram connector,
customer or key was added to the actual owner's database.

## Live acceptance still required

No real bot token, Telegram Business connection or provider key was supplied.
Accordingly, genuine customer-message delivery and account/OS-specific setup have
not been verified. The owner must enter the bot token in Settings, follow the
single-use binding link, connect that bot to the intended account/chats in
Telegram, configure AI/persona and enable automatic replies. Tokens should not
be pasted into this chat. Run one real inbound/reply and revoke-rights test after
setup before relying on the assistant. Production/PG/multi-host acceptance and
independent personal bot notification decisions remain open.
