# Password entry for local Web launches

Task: Phase 1 / Foundation, task 3 — auth/device scaffolding.
Owner request (2026-10-31): keep one email/password and request it on every
local launch. Owner explicitly selected asking on each launch.

Scope/assumption: a launch is a new local Vite Web-server process. Page reloads
and normal token refresh within that process keep the signed-in session. The
existing single-owner account and password hash persist in the backend database;
there are no default credentials or automatic password resets. OPEN architecture
decisions remain unchanged. No database migration or credential-storage change.

Implementation:

- `vite.config.ts`: each dev server injects a new non-secret launch ID and reports
  it in existing development metadata. The proxy preserves the browser Host,
  keeping exact-origin CSRF checks functional on fallback Web ports.
- `localBrowserLogin.ts`: enable the launch gate only for loopback Web development;
  native clients, test mode and production keep their existing sign-in behavior.
- `api.ts`: password login/setup records launch ID and backend origin in tab
  sessionStorage. Tokens and cookie restore from a previous launch cannot reopen
  the UI. Logout/backend changes remove the marker; passwords are never stored.
- `browser-session.test.tsx`, `api.test.ts`: regression tests for generation
  changes, wrong credentials, same-password reuse, reload/refresh and proxy origin.

Validation:

- `pnpm --filter @aelys/web typecheck` — PASS.
- `pnpm --filter @aelys/web test` — PASS: 47 files, 294 tests.
- `pnpm --filter @aelys/web build` — PASS.
- `PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_browser_auth.py`
  — PASS: 11 tests, including wrong credentials, single-owner setup, CSRF,
  refresh rotation, revocation and logout.
- Playwright: real browser, current app and backend, disposable SQLite database.
  Setup → dashboard → page reload stays signed in; restart Vite on the same
  port → password form; re-entering the same credentials opens the dashboard.
  The disposable account is unrelated to the owner's persistent database.

Limit: this is the local browser entry behavior; restarting only a backend while
keeping the same Web server does not create a new Web launch. A tab opened
without that launch's marker also requests password entry. Native builds are not
part of this change. Next verification before a native release remains the
separate native-auth/device acceptance flow.
