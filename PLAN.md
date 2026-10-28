# Aelys Backend and macOS Runtime Implementation Plan

## Scope

This goal implements the approved backend and headless macOS runtime scope from the repository specification. It intentionally excludes React, Tauri UI, Android, production deployment, and unresolved external integrations. The implementation is staged internally so every subsystem has a working contract and tests before dependent work is integrated.

## Assumptions and unresolved decisions

- PostgreSQL is authoritative for synced data; SQLite/local files are used only by the macOS runtime for local agent data.
- Gmail remains an import/local mail model; live OAuth and sending require a later approved integration decision.
- Telegram remains a bounded adapter/contract until its first-release scope is confirmed.
- Provider secrets use an encrypted secret-store abstraction backed by an environment supplied master key. The final server-side versus local key placement remains OPEN.
- Remote unattended CLI execution remains disabled unless the runtime isolation implementation and escape tests pass. A path allowlist alone is insufficient.
- The exact agent-loop SDK, Mac history backup policy, Android wrapper, and public license remain OPEN/PROPOSED per the decision register.

## Execution tracks

1. Foundation: Python package, configuration, database models/migrations, auth/device identity, common API errors, and test fixtures.
2. Domain APIs: projects/resources, notes, tasks/calendar, finance/timer, mail, AI settings/conversations, search/history/notifications.
3. Sync: versioned operations, idempotency, optimistic conflicts, ordered pull/bootstrap, and local-only session exclusion.
4. AI and automation: provider adapters, encrypted BYOK, routing, typed tools/policy, SSE lifecycle, usage/costs, and rule execution.
5. macOS runtime: Rust headless helper protocol, local SQLite session reader/index, CLI adapters, authenticated channel, run lifecycle, and security gates.
6. Integration: OpenAPI generation/validation, CI, documentation, cross-track tests, security/privacy inspections, and final acceptance report.

## Integration gates

- Each track must provide tests and a concise changed-file report.
- Shared API schemas, migration heads, app wiring, and final documentation are integrated by the lead after review.
- Full tests must pass before this goal can be marked complete. Unsupported or unverified behavior remains explicitly labeled as a spike or disabled capability.

## Follow-up prerequisites for Goal 2 and Goal 3

- Goal 2: frontend/client offline stores, generated TypeScript contracts, Android wrapper spike, device UX, and approved Gmail/Telegram integration scope.
- Goal 3: production deployment/backup topology, final Mac sandbox technology validation on target macOS versions, release signing/installers, license confirmation, and optional encrypted Mac-session backup decision.
