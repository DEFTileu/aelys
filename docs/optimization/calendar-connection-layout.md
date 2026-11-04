# Calendar connection and Mail scroll repair

Tasks handled sequentially within Phase 3: task 4 Mail layout repair, then task 1
Calendar connection repair. Existing approved UI and read-only Calendar scope
are retained; no OPEN product decision is resolved.

The Mail list used `display: contents`, placing every row directly into the
fixed-height card without a scroll container. Desktop now gives the rows a
shrinkable flex scroll area; the search stays outside it. Phone layout is intact.
Browser verification with 40 synthetic messages and a long unbroken URL confirms
independent list/body scrolling, no horizontal body overflow, and list bounds
inside the card.

Calendar had no deployed callback URI and still used an embedded WebView redirect
whose state cookie remained in Rust. The Google project also had Calendar API
disabled. Add the same bounded system-browser mechanism used for Gmail, a
nullable state marker in migration 0041, static native completion, status refresh
on return, exact callback validation and redacted handoff validation/access logs.
The shared native browser helper accepts only the two fixed provider paths and
checks the same session again before opening. Calendar retains its own state,
cookie, credentials, read-only scope and Policy Engine checks.

Deployment setup uses the existing Google Web application client and adds
`https://api-production-1cea.up.railway.app/api/v1/calendar/google/callback` to its
redirect URIs. Set backend-only `AELYS_CALENDAR_REDIRECT_URI`; preserve the existing
client secret and encryption key. Google owner consent and Calendar API enablement
are required before live acceptance can be claimed.

Validation: focused OAuth/migration tests 56 passed; web 589 passed; native
transport 47 passed / 2 interactive Keychain checks ignored. Ruff, mypy (99 files),
Bandit, strict Clippy, web TypeScript/production build, mobile host cargo check,
signed Mac release build passed. The first full backend run had 959 passed / 93
skipped and three migration head assertions requiring the new revision; updated
those assertions: their focused suites passed (4), then the full backend rerun
passed: 962 passed / 93 skipped (one existing Starlette deprecation warning).
