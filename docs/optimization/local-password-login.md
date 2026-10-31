# Password entry for local Web launches

Task: Phase 1 / Foundation, task 3 — auth/device scaffolding.
Owner request (2026-10-31): keep one email/password and request it on every
local launch. Owner explicitly selected asking on each launch.
Follow-up: the owner explicitly selected login `1` and password `1` for local use.

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
- `AuthGate.tsx`: local development uses a text login and accepts the requested
  short password for login `1`. Production retains the email/password form.
- `browser_auth.py`: a separate typed browser request supports the exact local
  `1` / `1` exception; peer IP, hostname and supplied Origin must be loopback.
  Normal password-hash verification and the owner lock still apply. No changes
  to generic/native password validation. Updated OpenAPI and security/API docs.

Validation:

- `pnpm --filter @aelys/web typecheck` — PASS.
- `pnpm --filter @aelys/web test` — PASS: 47 files, 295 tests.
- `pnpm --filter @aelys/web build` — PASS.
- `PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_browser_auth.py`
  — PASS: 15 tests, including wrong credentials, single-owner setup, CSRF,
  refresh rotation, revocation, logout and loopback-only `1` / `1` behavior.
- `.venv/bin/ruff check backend/app/core/browser_auth.py backend/tests/test_browser_auth.py`
  — PASS.
- Playwright: real browser, current app and backend, disposable SQLite database.
  Setup → dashboard → page reload stays signed in; restart Vite on the same
  port → password form; re-entering the same credentials opens the dashboard.
  The disposable account is unrelated to the owner's persistent database.
- Follow-up Playwright verification against the active local instance: created
  the requested `1` account in the previously uninitialized persistent database,
  signed out, signed back in with `1` / `1`, and opened Dashboard successfully.
  Refreshed the user's browser tab to show the updated login form.

Limit: this is the local browser entry behavior; restarting only a backend while
keeping the same Web server does not create a new Web launch. A tab opened
without that launch's marker also requests password entry. Native builds are not
part of this change. Next verification before a native release remains the
separate native-auth/device acceptance flow.
