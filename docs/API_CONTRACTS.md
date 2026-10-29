# Aelys — API Contracts v0.2

**Status:** proposed REST/SSE interface. Errors, DTOs and event names are drafts; finalize with OpenAPI/Pydantic, do not treat these as shipped endpoints. Prefix `/api/v1` throughout. All API operations authenticate; writes require authorization and idempotency.

## 1. Common conventions

- UUID strings for domain IDs, ISO8601 UTC instants, IANA timezone for recurrence.
- HTTP `Authorization: Bearer ...` or secure same-site session where appropriate. `X-Device-ID` must be bound to authenticated device, not trusted alone.
- Idempotent create: `Idempotency-Key` (client operation UUID) and ownership scope.
- Error envelope:

```json
{"error":{"code":"VERSION_CONFLICT","message":"Concurrent update","details":{"resource_id":"<uuid>","server_version":7}},"request_id":"<uuid>"}
```

Recommended error codes `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VERSION_CONFLICT`, `DEVICE_REVOKED`, `MAC_OFFLINE`, `POLICY_DENIED`, `MODEL_UNAVAILABLE`, `BUDGET_EXCEEDED`, `RATE_LIMITED`, `SYNC_RESET_REQUIRED`.

## 2. Identity & Devices

```http
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
GET  /api/v1/me
GET  /api/v1/devices
POST /api/v1/devices/enroll
POST /api/v1/devices/{id}/revoke
```

`devices/enroll`: short-lived enrollment, user verification, unique device credentials; no shared static secret embedded in open-source app.

## 3. Core & resources

```http
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{id}
PATCH  /api/v1/projects/{id}
DELETE /api/v1/projects/{id}
GET    /api/v1/projects/{id}/resources
POST   /api/v1/resource-links
DELETE /api/v1/resource-links/{id}
GET    /api/v1/activity?cursor=...
```

## 4. Productivity & personal modules

```http
GET/POST       /api/v1/notes
GET/PATCH/DEL  /api/v1/notes/{id}
GET            /api/v1/notes/{id}/revisions
POST           /api/v1/notes/{id}/restore
GET/POST       /api/v1/tasks
GET/PATCH/DEL  /api/v1/tasks/{id}
GET/POST       /api/v1/calendar/events
GET/PATCH/DEL  /api/v1/calendar/events/{id}
GET/POST       /api/v1/finance/transactions
GET/POST       /api/v1/finance/accounts
GET/POST       /api/v1/finance/budgets
GET/POST       /api/v1/focus/sessions
GET/POST       /api/v1/mail/messages
GET/POST       /api/v1/mail/drafts
GET            /api/v1/search?q=...&scope=...
```

`GET/POST` notation is documentation shorthand; OpenAPI must define each verb explicitly. `mail/messages POST` for local import, not arbitrary mail injection into connected provider.

## 5. Sync

```http
POST /api/v1/sync/push
GET  /api/v1/sync/pull?cursor=<token>&limit=200
GET  /api/v1/sync/status
POST /api/v1/sync/ack
GET  /api/v1/sync/bootstrap?scope=...
```

`POST /api/v1/sync/ack` accepts the device-bound pull cursor after the local
store has durably applied the page. The server stores the maximum acknowledged
sequence for that owner/device pair; acknowledgements never move backwards.

Example PUSH request:

```json
{
  "device_id":"<uuid>",
  "operations":[{
    "operation_id":"<uuid>",
    "resource_kind":"task",
    "resource_id":"<uuid>",
    "action":"update",
    "base_version":3,
    "patch":{"title":"Write API tests"}
  }]
}
```

Example response (per-operation, partial failures allowed, but atomically applied per operation):

```json
{
  "results":[{"operation_id":"<uuid>","status":"applied","version":4,"cursor":"opaque-cursor"}],
  "server_cursor":"opaque-cursor"
}
```

Pull:

```json
{
  "changes":[{"resource_kind":"task","resource_id":"<uuid>","version":4,"operation":"update","payload":{"title":"Write API tests"}}],
  "next_cursor":"opaque-cursor",
  "has_more":false
}
```

Cursor represents stable ordered server commits (see SYNC_PROTOCOL). Never expose raw Mac agent sessions in sync payload.

## 6. AI

```http
GET  /api/v1/ai/providers
POST /api/v1/ai/providers
POST /api/v1/ai/conversations
GET  /api/v1/ai/conversations/{id}/messages
POST /api/v1/ai/runs
GET  /api/v1/ai/runs/{id}/events     # SSE
POST /api/v1/ai/runs/{id}/cancel
```

Run request (example):

```json
{"conversation_id":"<uuid>","message":"Summarize today's tasks","routing":{"mode":"auto"},"tool_scope":{"project_ids":["<uuid>"]},"idempotency_key":"<uuid>"}
```

SSE event envelope:

```text
event: ai.text.delta
id: 103
data: {"run_id":"<uuid>","text":"..."}
```

Events `ai.run.started`, `ai.tool.requested`, `ai.tool.approved`, `ai.text.delta`, `ai.run.completed`, `ai.run.failed`. Persist sequence for reconnection where retention policy permits, **without storing raw private Mac session excerpts**.

## 7. Mac session index and remote runs

```http
GET  /api/v1/agents/sessions?project_id=...
POST /api/v1/agents/sessions/search
POST /api/v1/agents/runs
POST /api/v1/agents/runs/{id}/credential-lease
GET  /api/v1/agents/runs/{id}
GET  /api/v1/agents/runs/{id}/events     # SSE
POST /api/v1/agents/runs/{id}/cancel
GET  /api/v1/agents/devices
```

Search is a **forwarded live query** to authorized Mac. Backend does not store full text. Result may be transient/sanitized only. When Mac offline return `MAC_OFFLINE`, optionally include the list of harmless cached session metadata.

Remote run request:

```json
{"device_id":"<uuid>","project_id":"<uuid>","adapter":"codex_cli","task":"Run backend tests and report failures","policy_id":"<uuid>","idempotency_key":"<uuid>"}
```

Agent run statuses `queued`, `starting`, `running`, `waiting_approval` (for out-of-scope actions), `completed`, `failed`, `cancelled`, `expired`.

The credential-lease endpoint returns no secret. It returns a backend-signed,
single-use lease bound to the authenticated device, active run, project grant,
provider, expiry, and nonce. It is unavailable unless the operator configures
the runtime signing key and the grant has passed the isolation gate.

## 8. Automation

```http
GET/POST       /api/v1/automations
GET/PATCH/DEL  /api/v1/automations/{id}
GET            /api/v1/automations/{id}/executions
POST           /api/v1/automations/{id}/dry-run
```

## 9. Versioning and next steps

Generate OpenAPI 3.1 from FastAPI Pydantic models. Define explicit pagination, patch format, ETags/version preconditions, max payload sizes, rate limits, retry semantics and webhook signature checks (Telegram/Gmail where applicable) before code.
