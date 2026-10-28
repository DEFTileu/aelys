# Aelys — System Architecture v0.2

## 1. Architectural style

**PROPOSED:** modular monolith (`FastAPI`) + клиентские offline stores + отдельный локальный `Mac Runtime`. Не строить микросервисы для каждого бизнес-модуля. Публичный продукт single-user, но backend хранит owner IDs для безопасности и возможности self-host отдельного экземпляра.

```text
                 Web (IndexedDB)
                 macOS (Tauri + SQLite + helper)
                 Android APK (SQLite, wrapper TBD)
                           │
                 HTTPS API / SSE
                           │
                FastAPI Modular Monolith
      ┌──────────────┬───────────────┬──────────────┐
      │ Core/Projects│ Domain modules│ AI/Automation│
      │ Device/Auth   │ Notes/Tasks...│ Tools/Policy │
      └──────────────┴───────────────┴──────────────┘
                           │
                     PostgreSQL
                           │
             outbound authenticated Mac channel
                           │
               Mac Runtime / local store
                 Claude Code / Codex CLI
```

**Cloud stores no raw Mac agent sessions**. Live local retrieval is proxied under scoped requests and not persisted in request/response logs.

## 2. Domain boundaries

| Bounded context | Owns | May call/use |
|---|---|---|
| Identity / Devices | user, device, revocation, session | audit, sync |
| Projects & Resources | project, resource registry, links | task/note/event references |
| Productivity | notes, tasks, calendar, timer | Projects, Activity, Sync |
| Finance | accounts, categories, transactions | Projects, Activity, Sync |
| Mail | accounts, message metadata/body per policy, drafts | Integrations, Policy |
| AI Chat | conversations, tool requests, model routing | Domain service interfaces only |
| Local Agents | session index, run descriptors, device channel | Mac Runtime, Policy |
| Automation | rules, schedules, executions | Typed commands, events, Policy |
| Search | document indexes and secure retrieval | Domain adapters (data access filtered) |
| Sync | change log, versions, snapshots and operations | domain transaction boundaries |
| Audit | tamper-evident log where practical | all command handlers |

**Rule:** AI and automation are consumers of application services, not owners of business tables; forbid direct writes into domain tables from LLM agents.

## 3. Cross-module interactions

Example `task.created`:
1. Client produces `operation_id` and updates local SQLite.
2. `sync.push` authenticates and validates base_version.
3. Domain Tasks service persists record and audit in one transaction, writes outbox/change event.
4. Sync cursor assigned; event processor handles `task.created` without mutating original transaction.
5. Other devices pull change and apply locally.
6. Automation Engine checks trigger/conditions and uses policy-checked typed action.

Idempotency is critical both for Sync push and automation consumption. Maintain event IDs, process inbox/outbox safely; workers must support at-least-once delivery.

## 4. Authentication and permissions

- User auth: choose standard secure session flow (password + optional passkey/TOTP in later iteration), avoid static API key as only auth.
- Per-device credentials with revocation and rotation; scoped helper registration for Mac Runtime.
- Authorization: identity + resource ownership + scope of device + explicit project/tool grants.
- Local Mac path allowlisting bound to canonical directory inode/path and sandbox grant; symlinks and mounts handled by enforced isolation, not a string prefix check.
- Integration OAuth credentials are stored encrypted, never exposed to browsers, LLM prompts, telemetry.

## 5. Streams / transport

- REST JSON for CRUD and sync.
- SSE for `ai.runs/{id}/events` and UI-initiated agent run status (with reconnect cursors/IDs).
- **PROPOSED** authenticated, outbound Mac Runtime ↔ backend WebSocket for commands/status, with expiring leased work and sequence IDs; fallback long polling can be studied.
- A command may be `queued` while Mac offline; must expire or require cancellation according to policy.

## 6. Files and search

- Notes/files: explicit attachment upload flow, content hashes, quota, mime/type verification.
- Cloud search: only synced data authorized for server storage; default PostgreSQL FTS.
- Mac session search: SQLite FTS on Mac only; returned snippets are transient and scope-limited.
- Embeddings: do not produce/upload embeddings of Mac-only agent sessions without explicit new product decision.

## 7. Offline behavior

- Every write-capable client maintains operation queue; remote sync runs independently.
- Clients show durable pending/conflict state (UI semantics now, layout later).
- Concurrent edits: optimistic version control; conflict copies when merge unsafe.
- Server enforces constraints and canonical timestamps while accepting client-generated UUID.
- Time zones: UTC in storage for instants, IANA zone for recurrence and display.

## 8. Deployment independence

No dependence on a particular VPS, PaaS, proprietary queue or DB provider. Background jobs can initially run in the same deployed service topology with supervised worker process; scale later. PostgreSQL is the agreed logical authoritative store.

## 9. Monorepo structure (PROPOSED)

```text
/aelys
  apps/web/                # React/TS
  apps/desktop/            # Tauri 2 / Rust / macOS
  apps/mobile/             # Android target, wrapper decided by spike
  backend/app/
    core/ projects/ notes/ tasks/ calendar/ finance/ timer/
    mail/ ai/ agents/ automation/ sync/ search/ integrations/
  backend/tests/
  packages/api-contracts/  # Generated from OpenAPI / shared schema
  packages/shared/         # Cross-client domain types
  docs/                    # This package
  AGENTS.md
```

## 10. ADR alignment

See `DECISIONS.md`. Keep provider adapter, mobile wrapper, agent SDK and backup strategy replaceable until spikes settle them.
