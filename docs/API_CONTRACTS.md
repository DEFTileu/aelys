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
GET/POST       /api/v1/calendar/events/{id}/reminders
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

## Connected web workspaces (2026-10-29)

- AI provider `PATCH /ai/providers/{id}` updates model policy/enabled status.
  `POST /ai/providers/{id}/probe` verifies stored credentials without generating
  text. `GET /ai/providers` includes `has_secret`, never secret bytes.
- `GET /ai/conversations` lists owner chats. Runs accept
  `routing.provider_id`; completed assistant replies are persisted and included
  in subsequent turns. SSE reconnect replays stored events without another call.
- `POST /mail/import/eml` accepts one plain-text EML file up to 2 MB; the
  owner/content digest deduplicates imports. HTML is never executed.
- Mail draft PATCH requires `version`; draft DELETE requires `?version=`.
  Calendar PATCH/DELETE likewise require versions and return VERSION_CONFLICT
  for stale changes. Calendar instants return explicit UTC even on SQLite.
- Gmail endpoints under `/api/v1/mail/gmail`: status, connect, callback,
  `{account_id}/sync`, `{account_id}/drafts/import`,
  `{account_id}/drafts/{draft_id}` (explicit publication, version in body),
  `{account_id}/disconnect`. Sync/import return `next_page_token`; pass it as
  `page_token` to load another page. All except the state-validated OAuth callback
  require an owner/device bearer session. No Gmail send operation is exposed.

Offline writes for mail, calendar, finance and focus remain unavailable in
these screens until durable operation receipts and conflict recovery are wired
into their client stores.
The generated `docs/openapi.json` is the mounted schema.

## Phase 3 mounted contract (2026-10-29)

- `GET /api/v1/calendar/occurrences?starts_at=<ISO>&ends_at=<ISO>` projects
  overlapping occurrences in a positive window of at most 366 days. Each record
  keeps its series `id`/`version`, adds a stable `occurrence_id`, and includes
  `series_starts_at`/`series_ends_at` for whole-series edits. Supported RRULE
  frequencies are DAILY/WEEKLY/MONTHLY/YEARLY (COUNT or UNTIL, INTERVAL and
  date selectors); sub-day selectors are rejected. Start wall time follows the
  event's IANA timezone through DST, elapsed duration is preserved, nonexistent
  local times do not consume COUNT, and invalid month days are omitted. A
  bounded scan/response returns `RECURRENCE_LIMIT` instead of partial results.
- Event create accepts `reminder_at` and atomically commits the event and its
  in-app schedule. PATCH accepts it to replace pending schedules. New event and
  finance create requests bind an owner-scoped `Idempotency-Key` to a stable ID.
  Event PATCH and DELETE require a matching version; PATCH returns UTC instants.
- `GET/POST /calendar/events/{id}/reminders` lists/adds schedules;
  `DELETE /calendar/events/{id}/reminders/{reminder_id}?version=N` cancels one.
  The reminder's version changes on delivery. Recurring schedules preserve
  `offset_seconds` and `occurrence_at` for their next delivery. Each occurrence
  has its own notification deduplication key.
- `POST /calendar/reminders/dispatch` delivers due schedules for the authenticated
  owner, checks the Policy Engine, and atomically advances the schedule with its
  notification. The web shell calls it on foreground polling/opening the
  notification center, every 30 seconds while visible. Missed occurrences catch
  up in bounded batches. No closed-app push or external notification is claimed.
- Finance account/category/budget/transaction endpoints expose GET/POST. Monetary
  postings are immutable in this mounted contract; no PATCH/DELETE API is
  advertised. Transfers commit both signed postings atomically. Amounts and
  limits are Decimal strings (at most 16 integer and four fractional digits),
  floats are rejected, expenses are negative and income positive. Account
  currency and category kind must match a posting. Budget forms expose category
  and period explicitly. PostgreSQL uses NUMERIC; SQLite uses exact text storage.
- `/finance/summary` returns `count`, `currencies: [{currency,balance,income,expense}]`
  with string amounts. Legacy `total` is null for multiple currencies, never an
  implicit conversion. No exchange-rate source is assumed.
- Focus create binds its operation key to the original timestamps/task/project;
  an active-owner unique index prevents concurrent starts. List/start/stop
  return UTC timestamps and elapsed seconds. Stop accepts `?version=N`, checks
  the transition atomically, and repeated stop returns the original completed
  session without inflating elapsed time. Home and Timer use this same session.
- Task PATCH accepts a version; Home/Tasks send it and surface stale conflicts.
  Legacy callers omitting it remain compatible. Calendar/Finance/Focus writes
  default to online-only in the shared client and raise the typed
  `OfflineWriteUnavailableError` on a failed network request. UI disables writes
  when disconnected and identifies cached data. HTTP 5xx proxy failures can use
  GET cache; 401/403 never fall back to cache. Outbox HTTP rejections are retained
  for explicit resolution; automatic replay is not enabled for unsafe legacy
  operations.

### Implemented browser entry/session transport

`GET /api/v1/auth/browser/status` is public and returns only
`{initialized, can_resume}`; it never exposes the owner's email or credentials.
`POST /auth/browser/bootstrap` and `/auth/browser/login` accept `BrowserLoginRequest`,
create a web device, and return `{access_token, device_id, token_type}`.
The fields remain `{email, password}`. Passwords require at least eight
characters, with the owner-approved exact `1` / `1` exception only when the
peer IP, request hostname and supplied Origin are loopback. This still verifies
the stored owner password hash. Other short inputs return `422 VALIDATION_ERROR`;
generic/native `LoginRequest` retains its eight-character schema minimum.
Bootstrap shares the first-owner lock with native `/auth/bootstrap`; an existing
owner returns `409 ALREADY_INITIALIZED` and cannot be replaced.

`POST /auth/browser/refresh` and `/auth/browser/logout` use the HttpOnly
`aelys_refresh` cookie (path `/api/v1/auth/browser`, SameSite=Strict, Secure except
plain-HTTP loopback). The refresh credential is never in a browser JSON response
or JS storage. All browser POSTs require `X-Aelys-Browser: 1`; unexpected Origin
and cross-site requests return `403 CSRF_DENIED`. No wildcard credentialed CORS.
Responses use `Cache-Control: no-store`. The configured same-origin reverse
proxy is the supported web transport.

Refresh rotates the hashed credential atomically within the same owner/device
session, so valid access tokens in other tabs remain valid. Replays, expired
refresh sessions and revoked devices return 401. Logout revokes the shared
session, including its outstanding access tokens, and clears the cookie.
Legacy native JSON token endpoints remain available; browser clients use only
the cookie transport. The web gate preserves the requested route, restores the
session before mounting modules, and retries protected 401s once after a single
coordinated refresh (including the original write body/idempotency key).

### Implemented Telegram Business connector

All routes below require the owner/device bearer session and return no bot token.
Responses use `Cache-Control: no-store`; business data bypasses browser cache/outbox.

| Method | `/api/v1/integrations/telegram` path | Contract |
| --- | --- | --- |
| GET | `/status` | Configured bot, bound numeric owner, polling health, version, assistant settings, Business connections/rights |
| POST | `/connect` | `{bot_token}` write-only; verifies getMe/webhook state, encrypts token; same-token retry preserves state |
| POST | `/binding` | One-use 10-minute `{url,expires_at}` owner binding deep link |
| PATCH | `/settings` | `{version,enabled?,auto_reply?,instructions?,provider_id?,model?}` with version CAS |
| POST | `/disconnect` | Stops worker access, removes token/binding, purges Business message/connection records |
| POST | `/sync` | One bounded polling check; no webhook takeover; `{processed}` |
| GET | `/messages` | Latest 100 visible Business messages, versions and draft/delivery status |
| POST | `/messages/{id}/draft` | `{version}` generates through configured owner BYOK harness |
| POST | `/messages/{id}/send` | `{version,text}` explicit owner send, current Telegram rights/window, atomic claim |

`auto_reply` is initially false. Enabling requires verified Telegram owner,
Secretary Mode, a configured enabled AI provider/key and nonempty business
instructions. Incoming customers never grant these permissions. Pause remains
available even if the AI provider has been disabled. Automatic sends use the same
policy/claim path as manual sends. `unknown` delivery is terminal for automatic
retry because Telegram sendMessage has no server idempotency key.

Codes include `TELEGRAM_NOT_CONFIGURED`, `TELEGRAM_TOKEN_INVALID`,
`TELEGRAM_WEBHOOK_CONFLICT`, `TELEGRAM_BINDING_REQUIRED`,
`TELEGRAM_INSTRUCTIONS_REQUIRED`, `TELEGRAM_REPLY_DENIED`,
`TELEGRAM_REPLY_WINDOW_EXPIRED`, `TELEGRAM_DELIVERY_UNKNOWN`,
`TELEGRAM_RATE_LIMITED`, `PROVIDER_REQUIRED`, `BUDGET_EXCEEDED`, `VERSION_CONFLICT`.
No Telegram webhook route or arbitrary update-injection endpoint is exposed.

### Tasks UX instant boundary (2026-10-30)

`TaskIn.due_at` is normalized to UTC before persistence. `TaskOut` restores UTC
on SQLite-naive values and returns timezone-aware ISO instants for create/list/
get/PATCH, matching the existing calendar policy. `due_timezone` remains the
separate display/recurrence metadata. Legacy naive inputs/rows are interpreted
as UTC; a lost historical offset cannot be reconstructed automatically. The
wire schema is unchanged and no migration is required.

The Tasks web workspace sends full TaskPatch fields with `version`, preserves
parent/recurrence/description on toggle, and resolves 409 through an explicit
latest-version comparison. Writes are online-only; ambiguous creates require a
list check before a user-initiated repeat. No automatic replay or POST receipt
idempotency guarantee is introduced by this UX slice.

### Optimization reliability fixes (2026-10-30)

- Notes `PATCH /notes/{id}?version=N` now enforces the existing shared-client
  version parameter atomically. A stale version returns 409 VERSION_CONFLICT
  without changing the note or appending a revision. Legacy omitted versions
  remain compatible; the updated web editor sends its draft's base version.
- Note create/update accepts optional `folder: string | null` (max 120) and
  `tags: string[]` (max 50 labels, 80 characters each). Responses include both.
  Folder whitespace becomes null; tags are trimmed, a leading `#` removed and
  duplicates eliminated. Omitted organization fields on legacy updates preserve
  saved values. Explicit null/empty values clear them. The UI retains drafts
  when an older server does not return the requested organization values.
- `/search` preserves the result shape but projects only id/title in SQL and
  excludes tombstones. Full note/mail bodies are used in predicates, never
  materialized as result ORM entities solely to build search metadata.

### Native session pilot (2026-10-30)

The bounded native Rust transport uses `/auth/native/*`; browser cookie endpoints
are unchanged. Status returns `{initialized}`. Login/bootstrap accepts
`{email,password,platform:macos|android,display_name}` and atomically creates a
native Device and AuthSession. Response to native code only:
`{access_token,refresh_token,owner_id,device_id,token_type,expires_in}`.
Refresh accepts `{refresh_token}`, compares its hash atomically, rotates once
while retaining session identity, and rejects replay/expired/revoked/non-native
sessions. Logout accepts the current refresh token even after JWT expiry,
revokes exactly that session and returns `{logged_out:true}` idempotently.

Responses use no-store, set no cookies, and native endpoints reject browser
Origin/Fetch-Metadata headers. Header absence is not authentication: owner
credentials/session checks grant access. Validation errors do not reflect
passwords/tokens. Tokens are bearer credentials associated with a device record,
not hardware proof of possession. Client storage/IPC security and an actual
macOS restart test remain separate acceptance gates; Android is still a spike.

### Task deletion from the ACTUAL detail panel (2026-10-30)

`DELETE /tasks/{id}?version=N` performs the tombstone/version transition
atomically and returns `409 VERSION_CONFLICT` if another edit won the race.
Owner isolation and legacy calls without a version remain compatible. The
updated detail panel supplies its selected version and preserves the draft on
conflict; a client-side preflight alone is not the concurrency guarantee.
