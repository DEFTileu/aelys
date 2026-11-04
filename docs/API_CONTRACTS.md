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

`routing.effort` (optional): `off` (or omitted) sends no reasoning field; `low|medium|high` maps to Claude `thinking: {type:"adaptive"}` + `output_config: {effort}` (Claude requests never send `temperature`) and OpenRouter `reasoning: {effort}`. Any other value returns HTTP 400 `INVALID_EFFORT`. A non-off effort is echoed in the `ai.run.started` payload.

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
- `POST /mail/import/eml` accepts one EML file with text/HTML alternatives up to 2 MB; the
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
`{initialized, can_resume, password_setup}`; it never exposes the owner's email or credentials.
`POST /auth/browser/bootstrap` and `/auth/browser/login` accept `BrowserLoginRequest`,
create a web device, and return `{access_token, device_id, token_type}`.
The fields remain `{email, password}`. Passwords require at least eight
characters, with the owner-approved exact `1` / `1` exception only when the
peer IP, request hostname and supplied Origin are loopback. This still verifies
the stored owner password hash. Other short inputs return `422 VALIDATION_ERROR`;
generic/native `LoginRequest` retains its eight-character schema minimum.
Bootstrap shares the first-owner lock with native `/auth/bootstrap`; an existing
owner returns `409 ALREADY_INITIALIZED` and cannot be replaced. Operator password
bootstrap/login switches and rate limits also apply to the loopback exception.

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

### Note last-update instant (2026-10-31)

`NoteOut` now includes an optional `updated_at` (ISO 8601 date-time, the existing `Owned.updated_at` column). It is additive: older clients ignore it, and the web client falls back to the version badge when a backend omits it. No migration, no write-path change.


### Telegram personal + Business (2026-11-01)

Settings PATCH adds `timezone` (valid ZoneInfo/IANA, default UTC), `digest_time`
(nullable HH:MM, null disables), `reply_delay_seconds` (0–900, default 90).
GET status additionally returns active `status_text`/`status_until`; MessageOut
adds encrypted-at-rest `owner_note`. Unknown/expired busy status is not exposed
as active. Status commands are accepted only from the verified owner private chat.

The one bot handles `/task`, `/note`, `/today`, `/busy`, `/free`, `/help`.
Business AI returns strict reply/no_reply/handoff decisions. New terminal
`draft_status` values no_reply/handoff cannot enter automatic send claims. The
owner can explicitly send their own request text or regenerate a draft from
either status; owner_note never pre-fills the customer reply.
Handoff creates Notification kind telegram.handoff with only message_id data;
private owner_note is exposed only through the authenticated Telegram owner API.
See TELEGRAM_PERSONAL_ASSISTANT_REPORT.md for acceptance and sync limitations.
## Desktop design backend additions (2026-10-31)

### Focus pause/resume

- `POST /api/v1/focus/sessions/{id}/pause?version=N` and `/resume?version=N`
  (version optional, `409 VERSION_CONFLICT` when stale; repeating the same
  transition is a no-op; wrong state returns `409 INVALID_STATE`).
- `FocusOut` gains `paused_at` (set while `status = "paused"`) and
  `paused_seconds` (accumulated pauses). `status` is `active | paused |
  completed`. `elapsed_seconds` = wall time minus pauses and is frozen while
  paused. A paused session still occupies the owner's single timer slot and
  can be stopped. Migration `0025_focus_pause`.

### Agent session display metadata and stop

- `AgentSession` (`GET /agents/sessions`) gains optional, non-secret display
  fields reported by the Mac over `metadata_batch`: `workspace_path` (absolute
  path label, <=500 chars, no `..`/control characters; never read by the
  backend), `sandbox` (scope label, <=80), `network` (`blocked|allowlist|open`)
  and `events` (`[{kind, message, at}]`, newest 200 kept, messages redacted of
  token/key/password/Bearer patterns and truncated to 300 chars; metadata only,
  no transcripts or file contents). Omitting them in a batch keeps stored
  values; invalid values reject the item with `VALIDATION_ERROR`. Migration
  `0026_agent_session_display`.
- `POST /api/v1/agents/sessions/{id}/stop` asks the Mac runtime to stop the
  session through the existing run-cancel path. It fails closed: `404` for
  unknown/foreign sessions, `403 POLICY_DENIED` without a project and an
  active, isolation-validated grant, `403 DEVICE_REVOKED`, and `409
  NO_ACTIVE_RUN` when the device has no queued/running run for that project
  and adapter. On success queued runs become `cancelled`, running ones get
  `cancellation_requested` (delivered via run heartbeat), an audit row
  `agent.session.stop` is written and the response is
  `{session_id, status: "stop_requested", run_ids}`. Sessions are linked to runs
  by device+project+adapter+grant policy, since the index has no run id.

### Automation drafts and recent runs

- `POST /api/v1/automations/draft` body `{description}` or `{rule}` (exactly
  one) returns a PROPOSED rule and never saves or executes anything:
  `{source: "structured"|"ai"|"parser", rule, policy: {policy_ref, registered,
  allowed, issues[]}, saved: false}`. For `description` the owner's enabled AI
  provider (BYOK, budget-checked, usage recorded as an AI run) is asked first;
  the text is sent as `<untrusted_data>`-fenced content, the reply is accepted
  only if it parses into the strict rule schema, and the model can never pick
  the policy (always `safe`). Without a usable provider a deterministic parser
  handles sentences like `When a task is created in project "Home", create a
  notification "Review it"` (triggers `task|note` created/added/completed;
  actions `create_task|create_notification`; quoted title required). Anything
  else is `422 DRAFT_UNSUPPORTED`. The policy engine preflight reports
  unregistered policies, unauthorised actions and foreign projects in `issues`.
- `POST /api/v1/automations` accepts optional `reviewed_draft: true`. When set
  the same preflight is enforced at creation (`403 POLICY_DENIED` listing the
  issues); without it behaviour is unchanged and dispatch remains the
  authoritative gate.
- `GET /api/v1/automations/runs?limit=` (default 20, max 100) lists recent
  executions across the owner's rules, newest first:
  `{id, rule_id, rule_name, event_id, status, error_code, attempt, started_at,
  finished_at}`. `status` is `success` (completed), `skipped` (rate limited),
  `blocked_by_policy` (failed with `POLICY_DENIED`), `failed`, or `running`
  while in flight. No schema change.

### Widget data flags (2026-10-31)

All additive; migration `0027_note_pinned_mail_read`.

- Notes: `NoteIn`/`NoteOut.pinned` (bool, default false). `PATCH /notes/{id}?version=N`
  with `pinned` toggles it (version-checked, bumps `version`); clients that omit
  `pinned` keep the stored value.
- Mail: `MailMessageOut.is_read` (default false for imported/synced mail) and
  `version`. `PATCH /mail/messages/{id}` body `{is_read, version?}` marks
  read/unread; stale `version` is `409 VERSION_CONFLICT`, repeating the current
  value is a no-op that does not bump `version`.
- Finance budgets: `PUT /finance/budgets` body `{category_id|null, currency,
  month: "YYYY-MM", limit_amount: "decimal string"}` upserts the single budget for
  (owner, category, currency, month) (UTC month bounds; `null` category = overall
  budget) and returns the existing `FinanceBudgetOut`. Floats are rejected.
  `GET /finance/budgets` accepts optional `month` and `currency` filters. The
  legacy `POST /finance/budgets` is unchanged.
- Finance categories: `GET /finance/transactions` rows carry `category_name`
  (null when uncategorised); `GET /finance/categories` already lists names.


### Unified Task/Note/Event/Project sync (2026-11-01)

Mounted CRUD/capture writes now emit the same transactional SyncChange and
SyncRecord projection as device push; versions match the domain Owned.version.
Device push applies the validated patch to the actual domain row, preserving
Note revisions and owner-scoped references. Pull/bootstrap include REST,
Telegram and AI/automation writes, with versioned delete tombstones. Historical
ambiguous projection/domain divergence returns 409 SYNC_RECONCILIATION_REQUIRED
rather than silently choosing one body. Request/response envelopes are unchanged.


### Telegram reminders (migration 0029)

Settings/status add deadline_reminders (bool, false default) and quiet_start,
quiet_end (nullable HH:MM pair, both set to different times or both null).
TaskReminder and CalendarReminder channel accept in_app or telegram; the existing
foreground dispatcher only consumes in_app and the Telegram connector consumes
telegram. Internal pending_digest_on/at persist quiet-hour postponement and are
not exposed as editable settings. /remind schedules a TaskReminder plus capture
Task atomically; all reminder mutations and external sends pass Policy Engine.


### Telegram personal text queue (migration 0030)

Ordinary verified-owner private text is ingested transactionally with update
receipt/cursor into encrypted TelegramPersonalJob text/quote. Internal job states:
queued/running/done/failed. One durable running claim per integration; startup
fails interrupted running jobs and their bound AIRun without tool replay. The
persistent owner AIConversation is pinned at enqueue; `/new` starts another.
Existing AI run/event contracts and owner domain contracts are reused. Personal
tools use exact Task version CAS and the same domain/sync writer as REST.
No new public queue endpoint, sync resource_kind or credential exposure. Internal
queue data is excluded from owner export and re-encrypted by provider-key rotation.

### Personal media and transcription (migration 0031)

ProviderIn.kind also accepts transcription. Existing provider/secret endpoints
store the separate encrypted key, never return it; chat run selection and
Telegram settings reject this kind as a chat provider. model_policy supports
`default_model`, `monthly_budget` and `transcription_request_cost` (Decimal
strings, default estimate 0.10). Each transcription AIRun durably records the
configured estimate before external I/O; this is not actual billing.

Internal personal queue adds input_kind and encrypted media_metadata containing
bounded Telegram file_id/metadata only, no bytes. Untrusted photo/PDF/file turns
have no write grants; transcription is treated as owner text. Public chat message
HTTP inputs stay text-only; ephemeral provider attachments do not become a public
upload/storage endpoint or new sync kind. Rotation covers media_metadata.

### Explicit owner memory (migration 0032)

- `GET /ai/memory?limit=100&query=...`: active/unexpired owner facts, lexical
  query <=200 chars, no-store; no plaintext browser cache fallback.
- `POST /ai/memory`: `{text (1..2000),kind?,expires_at?}`. Provenance assigned
  by server as api; client cannot supply source or ownership. Normalized saves
  deduplicate, explicit re-save revives forgotten/expired identity.
- `PATCH /ai/memory/{id}`: required version, optional text/kind/expiry. Exact
  CAS; 409 VERSION_CONFLICT preserves current value; duplicate target returns
  409 MEMORY_DUPLICATE. `DELETE ...?version=N` soft-forgets with CAS.
- Responses include id, owner_id, version, text, kind, source/source_message_id,
  expires_at and created_at/updated_at. Memory validation failures return fixed
  typed errors without echoing input. Expired/forgotten facts are absent from
  selection immediately, including same-turn follow-up provider completions.

No new sync resource_kind. Explicit backend memory is managed through fresh
owner requests; the settings view never queues an unconfirmed forget or stores
plaintext facts in the shared offline cache. Export uses its encrypted envelope,
rotation re-encrypts text, and restore recalculates owner-specific hashes and
checks policy/collisions before insertion.

### Task work timestamps and matrix (Stage 6)

TaskOut adds nullable started_at/completed_at UTC instants, server-owned; TaskIn
and TaskPatch do not grant client control of these fields. Actual transitions
are stamped through the common domain change writer, preserving the exact Task
version in pull/bootstrap. Historical pre-feature rows remain unknown (null).
HistoryEntry retains immutable per-version status-transition metadata; no new
history table or sync resource kind. API/offline version conflicts preserve the
server's work dates and status. Final acceptance is recorded in the stage report.

### Read-only Google Calendar connection (ADR-028 Stage 7)

`GET /api/v1/calendar/google/status` returns `{configured, connection}`. A connection
contains only id/version/calendar_id/status/last_synced_at/last_error_code;
credentials, sync tokens and PKCE verifiers never cross this API. `POST …/connect`
returns `{authorization_url}`, sets a separate HttpOnly state cookie, and uses
`…/callback` for one-use PKCE consent. Consent is only `calendar.readonly`, separate
from Gmail. The callback returns to Settings → Google Calendar.

Native hosts use `POST …/browser-connect` to obtain a one-use ten-minute
`…/authorize?ticket=…` handoff. Rust validates the exact selected-backend path
and opens the system browser, which establishes its own HttpOnly state cookie.
The callback returns a static completion page for this flow. Session/device
revocation, expiry and replay reject the handoff; native capabilities and
provider tokens never enter renderer state or logs. Settings rechecks status
on browser return and while this bounded attempt is pending. Import stays an
explicit action; existing scheduled imports remain read-only.

`POST …/sync` performs a bounded, leased, atomic import and returns
`{imported, deleted, full_sync}`. Import counts mean changed local projections,
so importing unchanged data returns zero. `DELETE …/connection` clears credentials
and imported events, returns `{disconnected:true}` and publishes domain tombstones.
A connected primary calendar refreshes in the existing connector worker every
15 minutes; a transient failure keeps the previous snapshot/cursor and retries
on the next due interval. Revoked credentials require Reconnect.

Calendar `EventOut`/`EventOccurrence` include nullable `external_source` and
`external_id`. Imported events are read-only: REST patch/delete and device push
return `409 EXTERNAL_EVENT_READ_ONLY`; clients cannot forge or clear provenance.
Native events keep their existing CAS/version contract. Every import/cancellation/
disconnect uses the shared domain change writer. Recurrence exceptions apply to
Calendar, /today and bounded personal calendar reads.

Errors include `503 CALENDAR_NOT_CONFIGURED`, `404 CALENDAR_NOT_CONNECTED`,
`409 CALENDAR_RECONNECT_REQUIRED`, `CALENDAR_SCOPE_REQUIRED`, `CALENDAR_SYNC_BUSY`,
`422 CALENDAR_INVALID_DATA`/`CALENDAR_SYNC_LIMIT`, `502 CALENDAR_UNAVAILABLE` and
`403 POLICY_DENIED`. HTTP 410 is consumed internally by one full refetch. Provider
payloads and token-bearing URLs are never returned in error messages or logs.

### Independent manual Telegram chat messages (2026-11-01)

- `GET /integrations/telegram/chats` returns up to 100 known Business chats:
  `{business_connection_id,chat_id,can_send,send_disabled_code,reply_window_expires_at}`.
  It uses owner-scoped stored connection rights, pause/binding/cooldown and the
  latest visible incoming message. Timestamps include their timezone; sends
  additionally refresh Telegram authority before claiming transport. No-store.
- `POST /integrations/telegram/chats/send` requires `Idempotency-Key` (1..150)
  and `{business_connection_id,chat_id,text}` (1..4096). It sends a new owner
  message to that existing private chat without a reply target. Multiple messages
  are allowed while can_reply and the 24-hour incoming window remain valid.
  The response is the canonical `MessageOut` (`direction=owner`), also returned
  by `/messages`. Only incoming messages extend the window. No arbitrary new
  contacts, groups, media sending, offline outbox or automatic transport retry.
- Migration 0035 stores a content-free owner-scoped request receipt before I/O.
  Same key/payload replays a confirmed success; changed payload returns
  `409 IDEMPOTENCY_CONFLICT`. A concurrent claim returns
  `409 TELEGRAM_SEND_IN_PROGRESS`. Failed/unknown requests are not sent again
  with the same key; `TELEGRAM_DELIVERY_UNKNOWN` means check Telegram first.
  Stale sending claims become unknown. Text remains encrypted in the existing
  Business message table, not duplicated in receipts. Receipt payload hashes use
  HMAC and neither plaintext nor credentials are exposed in status/errors.
- Existing `/messages/{id}/send` keeps version CAS and one secretary reply per
  incoming message. Manual chat claims/activity suppress stale automatic replies.
  Policy, owner/device isolation, fresh permissions, pause, cooldown and window
  checks remain authoritative. Disconnect purges receipts before messages.

### Explicit Telegram reply and private media viewing (2026-11-01)

The secretary `/messages/{id}/send` path now sends ordinary text by default: the
internal inbound draft target is not a Telegram quote target. Independent
`POST /chats/send` additionally accepts optional positive `reply_to_message_id`
(the Telegram remote ID of an existing message in this same owner/connection/chat,
including known secretary sends). Omit it for ordinary messages. An explicit
reply must resolve locally to an undeleted same-chat message; otherwise
`404 TELEGRAM_REPLY_TARGET_UNAVAILABLE`. The durable receipt HMAC binds the
optional target. A key used for a reply cannot silently become a plain send.

MessageOut adds `reply_message_id` (existing secretary outbound remote ID),
nullable `reply_to_telegram_message_id` and nullable `media:{kind:photo|voice|audio,
file_size:number|null}`. File IDs, paths, filenames, bot tokens and download URLs
are excluded. Received caption/quote reference and encrypted metadata persist in
Business message storage, under its existing seven-day TTL; raw bytes never do.
Business media is visible only to the owner and does not enter AI processing.

`GET /integrations/telegram/messages/{id}/media` returns a bounded binary photo
or audio response for an authenticated active owner/Business connection. Limits:
photo 10 MiB, voice/audio 20 MiB. Fixed Telegram getFile/download paths are used
only on the backend; authority, message deletion and metadata are rechecked after
I/O. Headers: no-store, nosniff, inline and a sandboxed `default-src 'none'` CSP.
Content is identified by supported image/audio signatures; HTML/SVG/unknown
formats are rejected. Codes include `TELEGRAM_MEDIA_TOO_LARGE` (413),
`TELEGRAM_MEDIA_UNSUPPORTED` (415), `TELEGRAM_MEDIA_UNAVAILABLE` (422), policy
403 and deleted/foreign/not-present 404. Viewing does not grant message-send or
model access. Shared clients download capped blobs with authorization headers,
no cache/outbox, and the UI revokes in-memory object URLs on unmount/change.
Migration 0036 adds two nullable fields; encryption-key rotation covers metadata.

## Knowledge retrieval (2026-11-01)

See [KNOWLEDGE_RAG.md](KNOWLEDGE_RAG.md) for implemented consent, bounded retrieval,
read-only AI scope, source events, migration and acceptance limits. The generated
OpenAPI includes `KnowledgeScope`, `KnowledgeQuery` and `KnowledgeSource`.

Combined main migrations: `0037_merge_telegram_knowledge` joins the published
`0035_knowledge_consent` and `0036_telegram_reply_media` branches. Deployments
upgrade to this single head before serving the combined Knowledge/Telegram API;
there are no new endpoint permissions in the merge revision.

## AI Chat sources, approvals and attachments (migration `0038_ai_chat_design`)

- `GET /ai/conversations` items add `pinned`, `updated_at` (bumped by every new
  message), `preview` (first 90 plain-text chars of the last message) and
  `usage {input_tokens, output_tokens, estimated_cost}` summed over the chat's
  runs. `PATCH /ai/conversations/{id}` takes `{version?, pinned?, title? (1..80),
  scopes?}`; a stale `version` returns `VERSION_CONFLICT`. Pinning alone keeps
  `updated_at`.
- Source scopes `tasks.read`, `calendar.read`, `notes.read`, `knowledge.read` live
  in `tool_scope_json.scopes`. A new chat that omits `tool_scope.scopes` gets
  `tasks.read, calendar.read, notes.read`. Read tools (`list_tasks`, `read_calendar`,
  `read_note`) are offered and authorized only for switched-on sources. No mail or
  finance scopes exist. A chat with no scopes, or whose models lack tool calling,
  answers as plain text. Knowledge questions reject write scopes only.
- Write tools (`create_task`, `update_task`, `complete_task`, `create_note`,
  `create_event`, `create_reminder`) never execute in a run. They persist an
  `ai_actions` row and emit SSE `ai.action.proposed`
  `{run_id, action_id, tool, title, summary, items[{title, detail, meta}]}`.
  `GET /ai/conversations/{id}/actions` lists them (`status`: `pending|approved|rejected|failed`,
  `result`). `POST /ai/actions/{id}/approve` executes once through the tool registry
  with the owner's write scope (a repeat returns the stored result; a failure stores
  `result.error {code, message}` and status `failed`; rejected actions return 409).
  `POST /ai/actions/{id}/reject` is idempotent for rejected actions.
- `ai.tool.requested` / `ai.tool.result` carry `label` ("Read your tasks"),
  `source` (`tasks|calendar|notes`) and, on results, `detail` ("6 tasks, 2 due this
  week"). `ai.run.completed` carries `input_tokens`, `output_tokens`, `estimated_cost`.
- `POST /ai/attachments {name, content_base64}` accepts `.txt .md .csv .json .pdf`
  up to 2 MB (413 `ATTACHMENT_TOO_LARGE`, 422 for other types or unreadable files),
  extracts text, keeps it 24 h owner-scoped and returns `{id, name, size, chars}`.
  `DELETE /ai/attachments/{id}` removes it. `POST /ai/runs` accepts `attachment_ids`
  (max 5); text is injected as `<untrusted_data>` (20 000 chars per file, 40 000 total)
  and `GET .../messages` returns `attachments [{name, size}]` on user messages.
- `PATCH /ai/messages/{id} {feedback: "up"|"down"|null}` (assistant messages only);
  `GET .../messages` returns `feedback`.


### Bounded navigation reads (2026-11-04)

- `GET /api/v1/read/notes` and `GET /api/v1/read/mail` return
  `{items, next_cursor, etag, not_modified, facets}`. `limit` defaults to 50,
  accepts 1–100; `cursor` is opaque and bound to owner, resource and filters.
- `q` (up to 200 characters) searches server-side before pagination. Notes also
  accept `folder=unfiled|folder:<name>` and `tag`; the first page includes all
  owner-visible folder/tag labels without fetching full document bodies.
- Notes use ascending IDs; mail uses descending `(received_at, id)`. A next-page
  request must keep its original limit and filters. Existing full-list routes
  remain compatible.
- `If-None-Match` returns authenticated `304` with no body when unchanged.
  Native JSON transport uses `known_etag` and `not_modified: true`; the native
  adapter reconstructs HTTP 304. Responses use `private, no-store`; device
  snapshots are managed explicitly in the owner/backend partition.
- `GET /api/v1/read/mail/{id}` resolves an owned message outside the loaded page.
- Clients reuse confirmed collection reads for 60 seconds, deduplicate concurrent
  identical reads, invalidate affected families after writes, and bypass freshness
  on explicit refresh. Saved previews do not authorize online writes. A denied
  session removes previews and cannot read private fallback snapshots.

Validation and measurement: [navigation read optimization](optimization/navigation-reads-main.md).


### Gmail native browser handoff (2026-11-04)

`POST /api/v1/mail/gmail/browser-connect` requires the existing owner/device bearer
session and returns `{authorization_url}` for a one-use, ten-minute handoff at
`GET /api/v1/mail/gmail/authorize?ticket=...`. The browser sets the HttpOnly, Secure
(on HTTPS), SameSite=Lax OAuth state cookie and redirects to Google with PKCE.
The native renderer receives only the native-command completion boolean; native
Rust validates the selected backend origin/path before opening the system browser.
The callback rechecks owner/session/device authority and returns a static completion
page instead of redirecting to a frontend route on an API-only host. Legacy web
`POST /connect` stays compatible. Tokens, capabilities and callback codes are
excluded from frontend state, caches and diagnostic/access-log query strings.
`MailAccount.version` increases on reconnect, allowing clients to detect completion
without importing mail automatically. See [Gmail setup](GMAIL_SETUP.md).

### Formatted mail alternative (2026-11-04)

`GET /api/v1/read/mail/{id}` returns `MailMessageDetailOut`, adding optional
`body_html`. Mail collections/pages retain `MailMessageOut` without HTML; their
SQL also defers this large column. HTML is untrusted data, not executable UI.
Gmail explicit sync retains bounded text/html MIME alternatives and backfills
legacy null HTML once while preserving read state and message identity. EML
imports retain text and/or HTML and preserve owner/content digest deduplication.
Details use owner-partitioned device caching invalidated after mail writes.
The renderer sanitizes and isolates formatted content, blocks remote images by
default and offers a per-message image-load action and plaintext fallback.
