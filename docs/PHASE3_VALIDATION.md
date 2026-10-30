# Phase 3 — Calendar and personal modules validation

Date: 2026-10-29. Selected milestone: IMPLEMENTATION_PLAN.md / Phase 3.
This report covers the owner-requested web Calendar, Finance, Focus and Home
slice. It does not claim release readiness for the whole product.

## Assumptions and decision status

- Use the existing web design, mounted FastAPI domain API and owner/device auth.
- Native Calendar is the Aelys calendar, not a Google Calendar integration.
- Money postings remain immutable under the existing GET/POST contract; there is
  no invented ledger edit/delete endpoint. Budget category and period are
  explicit in the form. No implicit currency conversion or bank integration.
- RRULE uses python-dateutil for date recurrence, with bounded projection and
  explicit rejection of sub-day rules. Event edits affect the entire series.
- Reminder delivery is in-app and foreground, not OS push when the app is closed.
  Owner-created schedules grant only notification scope through Policy Engine.
- Durable personal-module write replay is not claimed: the objective explicitly
  permits an honest unavailable-write state where safe replay is not wired.
  The IndexedDB read cache is used, writes default to online-only, and shared
  errors expose OFFLINE_WRITE_UNAVAILABLE. Existing rejected outbox entries are
  retained for explicit resolution. No automatic replay is enabled for legacy
  operations without durable server receipts.
- Existing OPEN/PROPOSED decisions remain unchanged: Android wrapper viability,
  Mac CLI isolation, secret-store boundary, backup/retention, harness SDK,
  Telegram scope, external integrations, and license. None is needed to invent
  a provider or bypass isolation for this web slice.

## Requirement evidence

| Requirement | Authoritative evidence |
|---|---|
| Event create/edit/delete and version conflicts | mounted API, CalendarView, test_calendar_round_trip_preserves_instant_and_rejects_stale_edits; real browser create/edit/reload |
| UTC and timezone recurrence | EventIn/Out and occurrence projection; weekly New York DST, invalid RRULE/timezone, missing month day and nonexistent local-time tests |
| Working recurrence in the UI | bounded `/calendar/occurrences`; browser displays two daily instances with the same series; edits retain original series dates |
| Reminders | atomic event+schedule, add/list/cancel, recurring cursor/offset, policy-gated dispatch, NotificationCenter; browser delivered reminder; tests for repeat dedup/cancellation/policy rollback |
| Finance accounts/categories/budgets/postings/summary/transfers | FinanceView and mounted typed endpoints; API contract tests and exact-money test; browser saved account and `1250.5001` expense |
| Decimal without float | ExactMoney + migration 0019; typed string responses; exact `9999999999999999.9999` round trip; float/NaN/precision rejection; currency-separated summary |
| Atomic transfers | existing two-posting transaction and integrity validation, exercised by mounted API contract tests with Decimal response strings |
| Focus start/stop, task/project, elapsed history | versioned conditional stop, idempotent starts, partial active-owner index, linkage test, two concurrent start test; real browser reload restored active session and stop preserved elapsed time |
| Home data/actions | independent API/cache loading states, projected calendar, real project task progress; Home checkbox test includes version and real backend stale-write test; shared backend Focus controls |
| Offline cache and honest states | real FastAPI stopped, browser reloaded Finance and displayed cached exact ledger with disabled Save; shared 502-cache/401-no-cache tests; typed online-only error; outbox 401/409/422 retention tests |
| No runtime demo records | runtime loads endpoint data or empty/unavailable states; disposable browser test records exist only in temporary test DB, no runtime seed added |
| Contracts/migrations | shared TS request/response types, checked OpenAPI snapshot, migrations 0017–0020, API_CONTRACTS/DATA_MODEL/SELF_HOSTING updates |

## Commands actually run

- `PYTHONPATH=backend .venv/bin/pytest -q backend/tests`: **74 passed, 2 skipped**.
  The skips are PostgreSQL environment integration tests; one existing Starlette
  TestClient/httpx deprecation warning remains.
- `pnpm --filter @aelys/web typecheck`: pass.
- `pnpm --filter @aelys/web test`: **40 passed**.
- `pnpm --filter @aelys/web build`: pass.
- `pnpm --filter @aelys/shared typecheck`: pass.
- `pnpm --filter @aelys/shared test`: **20 passed**.
- `PYTHONPATH=backend .venv/bin/ruff check --select E9,F backend/app backend/tests`:
  pass (repository CI rule set; full-style Ruff has pre-existing violations).
- `PYTHONPATH=backend .venv/bin/mypy --explicit-package-bases --ignore-missing-imports --check-untyped-defs backend/app`:
  pass, 57 source files.
- `PYTHONPATH=backend .venv/bin/bandit -q -r backend/app -ll`: pass.
- `alembic upgrade head` and `alembic check`: pass on a fresh temporary SQLite DB
  through 0020, and on the upgraded browser-test DB; no schema drift.
- `git diff --check`: pass.

Real browser validation used Vite + FastAPI + a disposable SQLite database,
with real owner login/device enrollment and no mocked web transport. It covered
calendar recurrence/edit and notification delivery, exact finance posting and
summary, Focus start/reload/stop, and cached Finance after stopping FastAPI.
The native datetime input issue found in this run has a regression test.
No live Gmail/AI/Telegram or bank action was performed in this phase.

## Files and remaining boundaries

Primary changes: CalendarView, FinanceView, TimerView, HomeView/homeWidgets,
NotificationCenter/AppShell, shared api-client/types and tests; mounted
`domains/api.py`, recurrence/reminder services, ExactMoney, core models/export,
backend tests and migrations 0017–0020. OpenAPI and the documentation listed
above describe the resulting contract. Prior provider/mail work and unrelated
user design changes remain present. No blanket staging or commit was performed.

The web slice has explicit limits: no durable offline mutation replay for these
modules, bounded date recurrence, foreground reminders, no exchange-rate source,
and no promise of native signed releases or live external-account acceptance.
Those are not silently simulated. Old SQLite monetary precision already lost
before migration 0019 cannot be recovered; its downgrade refuses conversion
back to float. Migration 0018 requires explicit resolution of any old duplicate
active sessions instead of deleting data.

Next milestone/task: **Phase 2 / Offline-first vertical slice, task 1** — bind
Calendar/Finance/Focus mutations to durable local entities, server receipts and
sync changes, with user-visible conflict recovery, before enabling automatic
outbox replay or claiming offline writes for them.
