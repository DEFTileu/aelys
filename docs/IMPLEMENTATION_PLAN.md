# Aelys — Engineering Roadmap v0.2

**Guideline:** do not attempt to generate the entire platform in one giant coding run. Develop dependency-ordered, verifiable vertical slices. Product MVP is broad, so engineering delivery is split into milestones.

## Phase 0 — Architecture & security spikes

**Deliverables**: ADRs/confirmed OPEN answers, skeleton monorepo, operational definitions, minimum CLI compatibility test plan, Android Tauri 2 viability test plan.

- Review this document pack; flag contradictions and assumptions.
- Decide Gmail/TG first-shipment scope and Android wrapper acceptance criteria.
- Test whether Claude Code/Codex histories can be read from installed versions under explicit opt-in.
- Evaluate macOS sandbox isolation required for unconfirmed unattended remote commands; do **not** enable until validated.
- Evaluate LLM provider SDK abstraction. Document license choice.

Exit: critical blockers identified, owners/assumptions recorded.

## Phase 1 — Foundation (first coding goal)

**Deliverables**: backend app startup; React application skeleton; Tauri desktop skeleton; DB migration; auth/device scaffolding; CI; OpenAPI.

Tasks:
1. Monorepo with backend/tests, apps/web, apps/desktop, packages/shared.
2. PostgreSQL migrations for users/devices/projects/resources/resource_links.
3. Auth/device enrollment/revocation, typed errors, structured redacted logging.
4. Project CRUD and generic resource links, integration tests.
5. Generate shared TS API types from OpenAPI.

Exit: new project can be created via authenticated client and retrieved via API; tests green.

## Phase 2 — Offline-first vertical slice

**Deliverables**: SQLite macOS local store, IndexedDB web cache, idempotent push/pull, conflict handling, Notes + Tasks first.

Tasks:
1. Durable client outbox and server operations receipt.
2. Stable change-log cursor/bootstrap snapshot; test commit ordering.
3. Markdown Notes + revisions + Tasks CRUD.
4. Cross-device consistency E2E (Mac ↔ Web), after Android spike add Android.
5. Tombstone and user-visible conflict state contracts.

Exit: 100 offline operations and conflict tests pass, no dropped/duplicated writes.

## Phase 3 — Calendar & personal modules

**Deliverables**: native Calendar, Finance, Focus timer, searchable local resources, settings, Dashboard API, Mail domain and Telegram adapter.

Tasks:
1. Calendar/timezone recurrence and reminders.
2. Finance decimal ledger, categories, budgets.
3. Timer persistence + focus statistics.
4. Mail message/import/draft; live provider integration only if explicitly approved.
5. Telegram commands and verified binding if agreed for MVP.

Exit: each user scenario passes acceptance tests, offline behavior explicit.

## Phase 4 — AI Core

**Deliverables**: BYOK, secret store, provider adapters, model registry/router, AI Chat/SSE, typed tools and policy engine.

Tasks:
1. Provider connectivity health/probe.
2. Run orchestration and limits (steps, time, tokens/cost).
3. Read and create_task tools via domain services.
4. Search + provenance + redaction.
5. Prompt-injection evaluation and cancellation.

Exit: budget-constrained AI can safely work on Tasks/Notes; no raw keys in logs.

## Phase 5 — Mac session reader

**Deliverables**: opt-in runtime, local history discovery/FTS, allowed paths, minimal cloud index, live Mac search.

Tasks:
1. Adapters per installed CLI versions.
2. SQLite/FTS local database, indexing incremental.
3. Metadata whitelist syncing, egress policies.
4. Device channel and offline state.
5. Remote search with source references.

Exit: Mac online/offline privacy/evidence tests pass; no cloud transcript content.

## Phase 6 — Remote Agent Runner

**Deliverables**: secured run queue/status, safe Mac sandbox, Codex/Claude Code adapters, cancellation/recovery.

Tasks:
1. Project registration, explicit one-time autonomy grant.
2. Sandbox/security spike implementation and exploit tests.
3. Lease/idempotency statuses, structured events and cancel.
4. Android/Web run status flows.
5. Audit/observability without logs leaking private content.

Exit: sandbox out-of-scope access fails under tests, in-scope commands run autonomously. **Do not ship with mere cwd-based restriction.**

## Phase 7 — Automation and integrations

**Deliverables**: rule engine, typed domain events/outbox, safe scheduled actions, Mail/Telegram extended integrations as approved.

Tasks:
1. Versioned triggers, conditions, actions and per-rule policy.
2. At-least-once delivery with idempotent execution.
3. Dry-run, pause/disable, rate limits, audit.
4. Mail extraction → task; agent run completed → notifications.

Exit: replay tests pass, out-of-policy actions rejected.

## Phase 8 — Hardening/public open source

- Documentation for Mac/Android installers, release signing, clean onboarding.
- Threat model review, secure exports/backups, device recovery.
- CI/E2E performance regressions, schema migration strategy.
- License, contributor guide, community issue templates.
- Example/sample data only in repository; no personal content or credentials.

## Goal-size guidance for coding agents

- One milestone = several PR-sized tasks, not one unlimited diff.
- A `/goal` (where supported) should refer to a specific phase and acceptance criteria.
- Every run reports changed files, test evidence, deviations/OPEN questions and next dependent task.
- Create checkpoint commit after tested vertical slice; never blindly rewrite existing user work.
- Backend/domain API and sync correctness precede elaborate UI or AI workflows.

## Recommended FIRST coding goal

Implement **Phase 1 / Foundation** only after reviewing docs and obtaining answers to blockers. Do not create simulated Gmail/Codex integrations and claim they are production-ready.
