# Aelys Backend and macOS Runtime Implementation Plan

## Goal 2 addendum — frontend and cross-platform applications

This addendum extends the completed Goal 1 plan without changing its backend or
runtime decisions. The active Goal 2 order is:

1. Shared TypeScript contracts, API client, IndexedDB persistence and durable
   sync outbox against the shipped `/api/v1` OpenAPI contract.
2. Responsive React web shell using the supplied Aelys design reference: photo
   hero, desktop rail/sidebar, mobile launcher and AI Command Bar, theme and
   local widget layout persistence.
3. Functional domain screens connected to real backend endpoints. Empty,
   loading, offline, error and conflict states remain visible when data or
   credentials are unavailable.
4. Tauri 2 desktop wrapper with a narrow command surface into the existing
   `aelys-runtime` crate. Vendor execution stays fail-closed; the UI may report
   capability probes but may not start a vendor process.
5. Android Tauri 2 spike and build validation. The approach remains
   `PROPOSED / SPIKE` under ADR-006 until Android SDK, NDK, Java and APK tests
   are available. No fallback wrapper is silently selected.
6. Integration tests, OpenAPI drift checks, platform documentation and a
   handoff that records unsupported external integrations.

The attached design rebuild and the 13 local weather backgrounds are input
assets, not an instruction to copy a screenshot. The implementation must keep
the photo visible, use glass only for the hero/AI controls, and avoid a mobile
bottom navigation bar. Full Goal 2 completion requires real API and supported
platform evidence; a visual shell alone is not completion.

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
