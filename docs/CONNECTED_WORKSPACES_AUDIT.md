# Connected workspaces validation — 2026-10-29

## Scope and decisions

The owner requested working AI provider, Mail and Calendar screens, then selected
Gmail reading and drafts. Delivery is staged under Phase 4 provider connectivity
and Phase 3 personal modules. No send action is authorized or implemented.
Backend-side encrypted BYOK remains the documented temporary implementation;
this does not settle the broader server/local secret-store ADR.

## Delivered behavior

- AI: provider create/edit/enable/disable, secret replacement/deletion, read-only
  credential probe; provider/model selection; persistent conversations, replies
  and multi-turn context; SSE decoding and explicit incomplete-stream errors.
- Mail: bounded plain-text EML import with owner/content deduplication; search,
  reading and local reply/edit/delete drafts with version conflict checks.
- Gmail: OAuth web flow with PKCE, single-use state and browser/session binding;
  encrypted credentials and refresh/revocation; manual paginated mail/draft
  import; explicit remote draft create/update with uncertain-create retry guard.
  No send API. Existing local draft edits are preserved during remote import.
- Calendar: selected start/end dates, create/edit/delete, UTC round trips on
  SQLite, week/day selection and stale-edit/delete conflicts. Home task
  checkboxes update actual tasks rather than the old positional mock array;
  recurrence is projected with timezone-aware RRULE instances and in-app reminders. See PHASE3_VALIDATION.md for the full acceptance evidence.
- Finance and Focus Timer: account/category/budget/transaction/transfer and
  summary screens use the Decimal-backed finance endpoints; focus
  start/stop/history and the Home focus widget use persisted FocusSession
  records.

Schema additions include `0016_gmail_connection` and Phase 3 migrations 0017–0020. Shared TS contracts and the
mounted OpenAPI snapshot reflect the endpoints. Rotation/export handling excludes
Gmail credentials from owner exports and rotates encrypted token envelopes.

## Checks actually run

- `PYTHONPATH=backend .venv/bin/pytest -q backend/tests`: **74 passed, 2 skipped**
  (PostgreSQL environment tests), one existing Starlette deprecation warning.
- `pnpm --filter @aelys/web test`: **40 passed**.
- `pnpm --filter @aelys/shared test`: **20 passed**.
- Web/shared `typecheck`, web `build`: pass.
- Ruff `--select E9,F` on backend/app, backend/tests and rotation script: pass.
- Mypy on backend/app with explicit-package-bases, ignore-missing-imports,
  check-untyped-defs: pass; Bandit `-ll`: pass.
- Alembic upgrade head and check on a disposable SQLite DB: pass, no drift.
- `git diff --check`: pass.
- Browser smoke against FastAPI + Vite: owner bootstrap through the UI, live
  Calendar event with RRULE/reminder, live Finance empty states, Focus start,
  reload-based active-session restoration and stop/history persistence.

Real Chromium/Playwright, real temporary FastAPI+SQLite and Vite (no mocked web
API): bootstrap/device enrollment; EML import; reply draft save and reopen after
reload; event create at 09:00, edit/reload and confirmed delete; provider config
with a clearly fake test key then key removal. No request with that fake key
was sent to a provider. Screenshots/output are ignored under output/playwright.
The browser reports existing meta frame-ancestors and missing favicon diagnostics.

Injected Google/provider transports test OAuth state/revoked sessions, key
probe, encrypted tokens, refresh, import deduplication, draft publication/update,
no send calls, persistent context and event replay. These are not evidence of
live Google consent or a real model response.

## Remaining limits

Live Google consent requires an operator-created OAuth client and registered
callback URL. A real model response requires a real provider key/model ID.
No external credentialed acceptance was claimed. See SELF_HOSTING.md.

General offline write sync, attachment import,
Gmail label/delete mirroring and changes made to already imported drafts remain
unfinished. Read paths use the existing cache; new mail/calendar mutations do
not promise durable offline replay; finance and focus mutations also require the
API connection. Gmail imports are manual, 25 records/page,
and cached mail is retained after disconnect as disclosed in the UI. An
uncertain Gmail draft creation remains blocked for manual verification instead
of automatically retrying an external write. Full design/product acceptance,
weather data sources and native release gates remain separate
unfinished work.

No commits were created. Worktree changes predating this task (including design
assets and .claude skill files) remain present; no blanket staging was performed.
