# Native transport validation

Status: macOS desktop Rust boundary, backend contract and web adapter are
implemented for the bounded owner-scoped module surface. This is not a claim that
the Aelys platform gates or every module are complete.

## Scope

Files owned by this slice are `apps/desktop/src-tauri/**` and this validation
record. The webview does not receive tokens or cookies. Rust constructs all
native auth URLs, request headers and pilot routes. Existing CSP, browser
Origin handling, browser cookies, and runtime fail-closed behavior are
unchanged.

The native commands are:

```text
native_status(origin)
native_health(origin)
native_login(origin, email, password, bootstrap)
native_resume(origin)
native_logout(origin)
native_operation(origin, operation)
native_ai_events(origin, id, requestId, onEvent)
native_ai_events_close(origin, requestId)
```

The operation enum is a tagged strict JSON object. Home sources and local
owner-scoped module writes are included in the bounded allowlist; Gmail
OAuth/account management, provider secret writes, model runs, Telegram and
other external side effects remain outside it:

```json
{"type":"me"}
{"type":"projects"}
{"type":"project_create","project":{"name":"...","description":""}}
{"type":"project_patch","id":"project-id","version":1,"project":{"name":"..."}}
{"type":"project_delete","id":"project-id"}
{"type":"tasks","project_id":null}
{"type":"notes"}
{"type":"note_create","note":{"title":"...","markdown_body":"","parent_id":null,"project_id":null}}
{"type":"note_patch","id":"note-id","version":1,"note":{"title":"...","markdown_body":"","parent_id":null,"project_id":null}}
{"type":"note_delete","id":"note-id"}
{"type":"calendar_occurrences","starts_at":"2026-01-01T00:00:00Z","ends_at":"2026-01-02T00:00:00Z"}
{"type":"calendar_events"}
{"type":"calendar_event_create","event":{"title":"...","description":"","starts_at":"2026-01-01T10:00:00Z","ends_at":"2026-01-01T11:00:00Z","timezone":"UTC","all_day":false,"project_id":null,"linked_task_id":null,"rrule":null,"reminder_at":null}}
{"type":"calendar_event_patch","id":"event-id","version":1,"event":{"title":"...","description":"","starts_at":"2026-01-01T10:00:00Z","ends_at":"2026-01-01T11:00:00Z","timezone":"UTC","all_day":false,"project_id":null,"linked_task_id":null,"rrule":null,"reminder_at":null}}
{"type":"calendar_event_delete","id":"event-id","version":1}
{"type":"calendar_reminders","event_id":"event-id"}
{"type":"calendar_reminder_create","event_id":"event-id","reminder":{"event_id":"event-id","notify_at":"2026-01-01T09:00:00Z","channel":"in_app","idempotency_key":"reminder-key"}}
{"type":"calendar_reminder_delete","event_id":"event-id","reminder_id":"reminder-id","version":1}
{"type":"calendar_reminder_dispatch"}
{"type":"finance_transactions"}
{"type":"finance_accounts"}
{"type":"finance_categories"}
{"type":"finance_budgets"}
{"type":"finance_summary"}
{"type":"finance_account_create","account":{"name":"Cash","currency":"KZT","type":"cash"}}
{"type":"finance_category_create","category":{"name":"Food","kind":"expense"}}
{"type":"finance_transaction_create","transaction":{"account_id":"account-id","category_id":null,"amount":"1250.00","currency":"KZT","type":"expense","occurred_at":"2026-01-01T00:00:00Z","notes":"","idempotency_key":"posting-key"}}
{"type":"finance_budget_create","budget":{"category_id":null,"currency":"KZT","period_start":"2026-01-01T00:00:00Z","period_end":"2026-02-01T00:00:00Z","limit_amount":"50000.00"}}
{"type":"finance_transfer_create","transfer":{"from_account_id":"account-a","to_account_id":"account-b","amount":"5000.00","currency":"KZT","occurred_at":"2026-01-01T00:00:00Z","notes":"","idempotency_key":"transfer-key"}}
{"type":"focus_sessions"}
{"type":"focus_start","focus":{"task_id":null,"project_id":null,"started_at":"2026-01-01T10:00:00Z","mode":"pomodoro"},"idempotency_key":"focus-key"}
{"type":"focus_stop","id":"focus-id","version":1}
{"type":"mail_messages"}
{"type":"mail_accounts"}
{"type":"gmail_status"}
{"type":"ai_providers"}
{"type":"ai_conversations"}
{"type":"ai_messages","conversation_id":"conversation-id"}
{"type":"ai_run_create","run":{"conversation_id":"conversation-id","message":"...","routing":{},"tool_scope":{},"idempotency_key":"run-key"}}
{"type":"ai_run_get","id":"run-id"}
{"type":"ai_run_cancel","id":"run-id"}
{"type":"ai_run_events","id":"run-id"}
{"type":"mail_drafts"}
{"type":"mail_draft_create","draft":{"account_id":null,"thread_id":null,"recipients":[],"subject":"...","content":"..."}}
{"type":"mail_draft_patch","id":"draft-id","version":1,"draft":{"account_id":null,"thread_id":null,"recipients":[],"subject":"...","content":"..."}}
{"type":"mail_draft_delete","id":"draft-id","version":1}
{"type":"activity"}
{"type":"notifications"}
{"type":"notification_read","id":"notification-id"}
{"type":"task_create","task":{"title":"..."}}
{"type":"task_patch","id":"task-id","version":1,"task":{"title":"...","description":"","project_id":null,"parent_task_id":null,"status":"todo","priority":0,"due_at":null,"due_timezone":null,"rrule":null}}
{"type":"task_delete","id":"task-id"}
```

Unknown operation types and fields are rejected. The pilot contains no generic
URL, path, method, header, body-forwarding, WebSocket, grant, agent or
arbitrary domain proxy. AI events use one fixed route and an ordered Tauri
Channel, with four concurrent subscriptions, an 8 MiB total response bound and
a 300-second request timeout. The legacy operation still returns a bounded
batch; the shared fetch adapter uses the incremental command. These are not a
generic stream proxy. Task creates, patches and deletes do not auto-retry;
ambiguous mutation failures are surfaced as `MUTATION_OUTCOME_UNKNOWN`.

## Security boundary

Configured origins must be canonical HTTPS origins without credentials, path,
query or fragment. Plain HTTP is accepted only for literal `127.0.0.1` or
`[::1]` development loopback; `localhost`, alternate loopback forms and DNS
names are rejected. Reqwest uses normal TLS verification, no proxy, no
redirects, bounded connect/request timeouts and an 8 MiB response limit.

The Tauri command checks the caller window label and URL. Only the `main`
window at packaged `tauri://localhost` is accepted; the exact Vite
`http://127.0.0.1:5173` URL is accepted only in debug builds. The capability
file grants only `core:default` to `main`; remote windows are denied.

Rust stores the access token in memory and the refresh record in the macOS
Keychain service `com.aelys.desktop.native-session`, under the canonical origin
account. The record is JSON containing only the refresh token, owner ID, device
ID and origin. It is never returned through IPC, serialized into logs, placed
in frontend storage, or passed in shell arguments. A Keychain write failure
revokes the newly issued server session when possible and returns an error.
Resume removes the stored token before the one refresh request; an uncertain
rotation requires a fresh sign-in and never blindly retries the old token.

Domain HTTP requests snapshot the in-memory access credential and release the
session mutex before network waits. This lets AI cancellation and logout run
while the event response is open. A successful late response is withheld if
its session/origin has changed: reads fail with `SIGN_IN_REQUIRED`, mutations
with `MUTATION_OUTCOME_UNKNOWN`. No completed write is automatically replayed.
AI frames are decoded incrementally, allowlisted and redacted before each
Channel send. Registration and publication are synchronized with session changes;
login/resume/logout close the affected subscriptions. AbortSignal or reader
cancellation closes the exact native HTTP subscription, including while headers
are pending. The explicit AI run cancel operation remains responsible for
stopping generation on the backend. No credentialed provider/Keychain GUI run
has been performed for this revision.

## Checks run

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Current result: **21 focused tests passed**, plus the existing desktop test
targets with zero tests. The focused tests cover origin and loopback policy,
packaged/debug window restrictions, strict operation input and route mapping,
status/response secret redaction, storage failure and rotation replacement,
HTTP error redaction, response bounds path, and redirect denial.
The current loopback HTTP tests also prove cancellation can reach the backend
before an event response closes, and that reads/mutations do not publish data
from a session cleared or replaced while awaiting the response. The original
blocking failure and commands are recorded in
[native-ai-cancellation.md](optimization/native-ai-cancellation.md).

Three further HTTP tests exercise nine operations against synthetic loopback
responses: Projects and Notes create/PATCH/list, Focus start/stop/list. They
reproduced and fixed missing singular Project/Note sanitizers and Focus writes
being sent to the list sanitizer. Unknown server-only fields are still removed.
See [domain response contracts](optimization/native-domain-response-contracts.md).

Five streaming regressions cover bytewise UTF-8/CRLF frames and keepalives,
first-event delivery before server EOF, connection closure during header/body
waits, origin-scoped subscription cancellation, invalid MIME/truncated responses,
and the size bound. Six frontend Channel tests cover incremental delivery,
ordered termination, abort registration races, reader cancellation and errors.
The full web suite passes 165 tests. See
[native AI streaming](optimization/native-ai-streaming.md) for commands and limits.

The tests use a fake store for deterministic failure/rotation behavior. Real
Keychain prompt behavior, backend integration, login, refresh, logout,
revocation, CRUD and restart restoration still require an owner-authenticated
native QA run. Frontend IPC wiring is covered by the web adapter tests and the
fresh packaged app reaches the native login screen. Do not accept unexpected
Keychain permission prompts automatically; the owner must handle any required
OS prompt.

Remaining validation for this slice is a real packaged-app run against an
isolated synthetic backend: login/bootstrap, `native_status`, resume after
restart, one concurrent refresh race, revocation, logout idempotence, and each
pilot operation. Unsupported modules must remain visibly unsupported until
their own typed commands exist.
