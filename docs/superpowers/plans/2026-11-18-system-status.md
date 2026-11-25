# Application status implementation plan

Owner requested a fast status screen inside Aelys and Luna subagents, and confirmed the in-app approach on 2026-11-18.

Scope: IMPLEMENTATION_PLAN Phase 1 task 3, safe operational observability.

Design: extend existing Settings with a shared desktop/mobile Status panel. Show live authenticated API/database reachability, process uptime, sync cursors, enrolled devices and a bounded owner-only audit event list. Poll every 30 seconds while visible, allow manual refresh, and distinguish unavailable data from healthy data. Reuse existing styles and transport. No raw process logs, secrets, transcript content, or infrastructure-provider changes.

Alternatives: existing healthz alone cannot establish DB reachability; a separate monitoring application adds deployment work. The owner selected an in-app screen. Full infrastructure monitoring and worker probes remain outside this slice.

Implementation ownership:
- Backend Luna agent: typed authenticated system/status and system/events endpoints, owner isolation/redaction tests, router registration.
- Frontend Luna agent: shared StatusPanel, settings navigation on both layouts, lifecycle/error tests.
- Lead: shared typed client methods with live-only tests, mobile title, contract documentation and integration verification.

Verification: focused backend and frontend tests, shared client tests, TypeScript checks, web production build. Review authentication, no-store handling, no stale healthy states, hidden-tab polling, unmount cleanup and secret exclusion. No migrations: existing audit records are read only.

Assumptions: DB reachability means successful authenticated DB access, not an exhaustive database health assessment. Device enrollment is not online presence. Sync cursors do not prove the local outbox is empty. Logs are a bounded audit journal, not stdout. OPEN decisions remain OPEN.

## Verification results

- `pnpm --filter @aelys/web test`: 100 files, 973 tests passed.
- `pnpm --filter @aelys/shared test`: 3 files, 80 tests passed.
- `pnpm --filter @aelys/shared typecheck`: passed.
- `pnpm --filter @aelys/web build`: TypeScript and production build passed; existing rich-text editor chunk exceeds the 500 kB warning threshold.
- `PYTHONPATH=backend .venv/bin/pytest backend/tests/test_system_status.py backend/tests/test_openapi_security.py -q`: 8 passed; existing Starlette/httpx deprecation warning.
- Scoped Ruff and `git diff --check`: passed. Checked-in OpenAPI matches mounted routes.
- Browser: signed into a disposable local SQLite instance and opened `/settings?section=status`; live API/database, uptime, sync acknowledgement, device count and empty journal rendered. Desktop screenshot inspected. Packaged native/mobile acceptance and production deployment were not performed.
- Independent Luna review found no additional actionable defects; live cache fallback, StrictMode request cleanup and UTC event timestamp issues identified during integration were corrected.

Next: deploy both backend and web together through the normal authorized release flow; validate the installed native application separately. Existing unrelated working-tree edits were preserved.
