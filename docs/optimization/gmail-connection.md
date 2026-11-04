# Gmail connection repair

Task: IMPLEMENTATION_PLAN Phase 3, task 4 (Mail read/import/drafts).
Owner reports Gmail account connection does not work.

Confirmed: deployed Railway API has no Gmail OAuth client ID, client secret or
callback URI. Native Settings currently navigates the app WebView to Google;
Rust owns the initial Set-Cookie, so the system browser cannot complete that
cookie-bound flow. The API-only host has no /mail frontend to receive a redirect.

Implement a bounded native-to-system-browser handoff, retaining PKCE, cookie and
owner/device-session checks, plus a safe completion page and account refresh.
The opener platform plugin is needed to open the actual OS browser on Mac/Android;
no generic URL or filesystem opening permission is granted to the frontend.
Existing web flow, read/draft scopes and mail data remain compatible.

Live setup needs an owner-created Google Web application OAuth client and Google
consent. No OAuth secrets in chat, source, frontend, logs or LLM content. Owner explicitly authorized creating the OAuth client in the browser. Google Cloud
is currently at account selection/sign-in; owner login is required before setup.
Sending email is outside the approved read/draft scope and remains unavailable.


## Validation

- Backend full suite: `PYTHONPATH=backend python -m pytest backend/tests -q`:
  945 passed, 93 skipped before the final callback-configuration cases.
- Final focused Gmail/Calendar OAuth and migration suite: 44 passed, including
  preserved legacy state across upgrade/downgrade, a separate cookie jar/system
  browser, replay, expiry, logout/device revocation and invalid callback URLs.
- Web full suite: 583 passed. Final connection/auth-focused tests: 11 passed.
  An unrelated AI duration test first expected 0.0s and received 0.1s under
  concurrent compilation; it and the complete web suite passed on rerun.
- Shared client: 74 passed. Web/shared typechecks, Ruff, mypy (99 source files),
  Bandit -ll, Rust fmt and Clippy -D warnings passed.
- Native library: 46 passed, 2 ignored interactive Keychain tests. Desktop and
  mobile host cargo checks passed on macOS. A signed macOS release bundle was built.
- Production Gmail consent and account import remain pending real OAuth setup;
  provider calls in automated tests use controlled Google fixtures.
