# Browser entry/session slice — 2026-10-29

Selected task: `IMPLEMENTATION_PLAN.md`, Phase 1 / Foundation, owner/device auth
scaffolding: complete a single web entry/sign-in flow and session restoration.
This report covers that auth slice, not completion of all Personal OS modules.
Existing uncommitted implementation work was preserved; nothing was staged or
committed. No migrations or credential resets were needed for this slice.

## Problem and resulting behavior

Modules previously mounted before authorization. Finance showed generic records
errors; Tasks directed the owner into Settings. Web login discarded the owner's
refresh token, replacing its access token with a 15-minute enrolled-device token
without a usable refresh credential.

The root auth gate now offers setup only on an empty instance and otherwise asks
for the existing owner's credentials. It mounts all modules only after a valid
session is established/restored and preserves the requested route. Settings
contains sign-out rather than a second initialization/login flow. A shared
transport automatically renews access and retries each rejected request once,
preserving its body and idempotency key. Concurrent requests share one renewal;
Web Locks coordinate tabs. Expired/revoked refresh credentials return the whole
shell to sign-in. Successful background renewals do not remount editors.

Refresh is a rotating HttpOnly cookie, bound to a real web device and database
session. Its stable session identity keeps other tabs' valid access tokens usable
while rotation/replay checks remain atomic. Logout revokes outstanding tokens;
device revocation prevents restoration. Origin/custom-header/SameSite controls
protect cookie POSTs. Both native and browser bootstrap serialize owner creation.

## Files in this slice

- `apps/web/src/components/AuthGate.tsx`, `App.tsx`: entry, restore and connection UI.
- `apps/web/src/lib/api.ts`: cookie auth, shared refresh/retry, local sign-out intent.
- `apps/web/src/views/SettingsView.tsx`, `TasksView.tsx`: remove the Settings login detour.
- `apps/web/src/tests/browser-session.test.tsx`: gate, restore, concurrent renewal,
  credential rejection, offline sign-out and idempotent write retry.
- `backend/app/core/browser_auth.py`: typed browser auth transport and cookie policy.
- `backend/app/core/api.py`: shared bootstrap lock, atomic native refresh consumption.
- `backend/app/core/config.py`, `app/main.py`: trusted origins, routes, no-store headers.
- `backend/tests/test_browser_auth.py`: session lifecycle, access to actual module APIs,
  CSRF, replay, revocation, concurrent first setup and existing-owner preservation.
- `packages/shared/src/types.ts`: browser status/session DTOs.
- `docs/API_CONTRACTS.md`, `SECURITY.md`, `SELF_HOSTING.md`, `openapi.json`: actual contracts.

## Validation

| Command | Result |
| --- | --- |
| `PYTHONPATH=backend .venv/bin/pytest -q backend/tests` | 87 passed, 2 skipped (PostgreSQL environment), one existing Starlette deprecation warning |
| `pnpm --filter @aelys/web test` | 50 passed |
| `pnpm --filter @aelys/shared test` | 20 passed |
| `pnpm --filter @aelys/web typecheck` | passed |
| `pnpm --filter @aelys/shared typecheck` | passed |
| `pnpm --filter @aelys/web build` | passed |
| `PYTHONPATH=backend .venv/bin/ruff check --select E9,F backend/app backend/tests` | passed |
| `PYTHONPATH=backend .venv/bin/mypy --explicit-package-bases --ignore-missing-imports --check-untyped-defs backend/app` | passed, 58 files |
| `PYTHONPATH=backend .venv/bin/bandit -q -r backend/app -ll` | passed |
| `PYTHONPATH=. ../.venv/bin/alembic check` (backend cwd) | no model/schema drift on local SQLite at migration 0021 |
| `git diff --check` | passed |

Browser verification used disposable SQLite/owner data on `localhost:5174`
with a separate temporary backend on port 8001. One login opened Finance and
Tasks. Creating a task persisted it through reload. Advancing only the fixture's
JWT clock by 16 minutes forced real access expiry: reload transparently renewed
the session and the saved task remained. A new tab restored from the cookie
without entering credentials. Sign-out from Settings returned both tabs to the
entry screen. Temporary servers/tabs were stopped after verification.

The actual app remains running on `http://127.0.0.1:5173` with backend on port
8000. Its existing owner/database were preserved. The main Finance URL visibly
shows the entry form rather than protected-module error cards. No test account
or test task was added to that database.

## Assumptions, limits and next step

The owner still signs in once with the existing account; this change does not
recover or replace its password. The web deployment uses the same-origin API
proxy; remote hosting requires HTTPS and exact trusted proxy origins. Access and
refresh durations retain the configured 15 minutes / 30 days. Offline sign-out
prevents local cookie restoration but cannot revoke a server credential until
the server receives a logout/device-revocation request or that credential expires.
PostgreSQL-specific integration checks were unavailable; its initialization lock
uses the same transaction advisory lock across transports. Existing OPEN and
PROPOSED architecture decisions remain unchanged. Gmail/provider external
credentials remain separate prerequisites for those integrations.

Immediate next step: owner enters the existing email/password on the local
entry screen. All module requests then share that session; no per-module setup
of owner authentication is needed.
