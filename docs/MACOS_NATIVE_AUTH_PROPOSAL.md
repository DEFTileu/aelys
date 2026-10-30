# macOS native session boundary — proposal

2026-10-30. Phase 1 Foundation follow-up; **proposed contract, not implemented
or approved as an API contract**. Backend and shared-client owners must reconcile
the names and schemas with their implementation before desktop code relies on
them. This document does not close any platform or security gate.

## Current gap and scope

The bundled webview runs at `tauri://localhost`; the frontend's `/api/v1`
default has no backend proxy there. Browser auth uses an HttpOnly refresh cookie
and browser-origin protections. Existing native `/auth/login` returns an
owner-only session; `/devices/enroll` returns a device access token but no
renewable device-bound refresh credential or implemented credential exchange.
The runtime's `MacOsKeychainReader` only reads fixed vendor CLI credentials;
it is not a desktop session store.

Pilot: existing-owner sign-in, device-bound renewable session and explicitly
enumerated Projects/Tasks operations. First-owner setup, broader domain APIs,
sync, agent execution and streaming are separate work. No browser Origin
stripping, cookie emulation, CORS change, CSP relaxation or generic proxy.
Keychain is a proposed implementation of the documented secure OS storage
direction, not the separate OPEN question about provider BYOK storage. This
design requires security review and evidence, not an inferred additional owner
approval gate.

## Proposed native backend contract

All paths are under `/api/v1`, JSON requests and responses, no cookies. These
names and semantics are proposals; the parent/backend owner owns the contract.
Every session is bound server-side to its owner and macOS device; token claims,
session record and device must agree on every authenticated call.

| Method and path | Request | Success response |
| --- | --- | --- |
| `POST /auth/native/login` | `{"email":"...","password":"...","device":{"platform":"macos","display_name":"..."}}` | `{"access_token":"...","refresh_token":"...","token_type":"bearer","device_id":"...","session_id":"...","access_expires_at":"UTC RFC3339","refresh_expires_at":"UTC RFC3339"}` |
| `POST /auth/native/refresh` | `{"refresh_token":"..."}` | Same response shape with rotated credentials, same device and session identity. |
| `POST /auth/native/logout` | `Authorization: Bearer <access_token>`; empty JSON object | `{"logged_out":true}`; revoke that session and its refresh credential. |

Login atomically verifies owner and creates the device/session; incorrect
credentials fail without token disclosure. Refresh uses an atomic compare and
replace of the stored refresh hash, and never accepts a revoked/expired device
or session. Access tokens remain session-bound; device revocation invalidates
both access and refresh. Use `Cache-Control: no-store` and sanitized typed error
codes (`UNAUTHORIZED`, `DEVICE_REVOKED`, `VALIDATION_ERROR`, and a bounded
service-unavailable error); no request bodies, secrets or raw headers in logs.
Logout when offline clears local credentials immediately but cannot assert server
revocation; report that state accurately. Clarify server revocation/recovery of
the abandoned session without retaining a secret for automatic logout.

## Desktop boundary and storage

Rust owns the client and session. Expose narrowly typed Tauri commands such as
`native_session_status`, `native_login`, `native_logout` and each pilot
operation below; no frontend-supplied URL, method, arbitrary headers or bearer
token. Status returns only state, backend origin and non-secret device/session
identifiers as needed. Login accepts email/password once from the webview;
passwords, token responses, Keychain values and raw transport errors never
return to JS or logs. Render domain responses and sanitized typed failures.
Limit command access to the main window and preserve the existing Tauri
capabilities and CSP. The webview remains trusted app code: typed commands limit
its reach but cannot prevent compromised frontend code from invoking allowed
operations or seeing permitted domain data.

Parse and canonicalize an explicitly user-configured origin (scheme, host,
port); reject userinfo, paths, query, fragments, unsupported schemes and
ambiguous host forms. Require HTTPS with standard CA and hostname validation;
allow plain HTTP only when the configured host is exactly localhost, 127.0.0.1
or ::1 for local development, with no DNS-based loopback exceptions. Disable
redirects, ambient proxy use and credential forwarding across origins. Build
fixed routes internally, bound timeouts and response sizes, and use no WebView
CORS bypass. Origin changes invalidate the in-memory session and must not
reuse stored tokens for the new origin.

Keep access tokens in memory. Optionally persist the refresh credential using
macOS Keychain generic-password APIs via the established `security-framework`
crate, justified by native secure storage; do not pass secrets through shell
arguments. Proposed service: `com.aelys.desktop.native-session.v1`; account:
`<sha256(canonical-origin)>:<device-id>:<session-id>`. Store a versioned record
containing the canonical origin, device/session identifiers, refresh token and
expiry; verify all fields on read and bind to the configured origin. A separate
non-secret selected-session reference can locate the item. Use an appropriate
device-local Keychain accessibility/access policy, document signing-dependent
access behavior, and never share this namespace with vendor CLI credentials.
Treat Keychain denial, locked state and corruption as explicit errors; never
fall back to plaintext, frontend storage, logs or another origin. In-memory-only
mode is supported but cannot restore a session on restart.

Serialize refresh per session. Persist a received rotated credential before
exposing the session as resumable, and replace the single Keychain record
atomically where the platform permits. A timeout, lost response, crash after
server rotation, or Keychain write failure can leave only an invalid old token;
the client must not loop or claim restoration. Clear/quarantine the unusable
local credential and require a fresh owner login. If the new token is still in
memory after a persistence failure, report non-persistent state and do not
pretend restart is safe; retain it only under a deliberately tested policy.
Do not introduce a retry grace window without a separate backend security
design. Logout must not resurrect a stale stored credential after crash: clear
local Keychain state before reporting local logout complete, and report a
storage error if deletion fails.

## Pilot operation allowlist

Commands construct exact paths and encode validated IDs as individual path
segments; UUID validation should follow the actual backend ID contract. No
arbitrary path prefixes or caller-controlled query keys. Requests use existing
API types and reject unknown fields, oversized inputs and invalid values.

| Command | Fixed HTTP operation | Input and output |
| --- | --- | --- |
| `list_projects` | `GET /api/v1/projects` | No input; `ProjectResponse[]`. |
| `create_project` | `POST /api/v1/projects` | `ProjectCreate {name, description}`; `ProjectResponse`. |
| `list_tasks` | `GET /api/v1/tasks` | Optional typed `project_id` query only; `TaskOut[]`. |
| `get_task` | `GET /api/v1/tasks/{id}` | Task ID; `TaskOut`. |
| `create_task` | `POST /api/v1/tasks` | `TaskIn`; `TaskOut`. |
| `update_task` | `PATCH /api/v1/tasks/{id}` | Task ID and full `TaskPatchIn`, requiring `version >= 1` in the native command; `TaskOut`, or `VERSION_CONFLICT`. |

`TaskIn` contains title, description, project_id, parent_task_id, status,
priority, due_at, due_timezone and rrule, with existing backend semantics;
`TaskOut` adds id and version. Dates retain UTC/IANA behavior. No delete,
project grants, arbitrary resources, or other routes are implied by the pilot.
These existing creates lack proven receipt idempotency: on timeout or lost
response report an ambiguous outcome and require a list check before a
user-initiated retry. No automatic offline replay or false durable-write claim.
Refresh once only when a request has a definite authentication rejection;
replay writes only when the backend guarantees rejection occurred before any
effect, otherwise surface uncertainty. Streaming requires separately specified
typed event channels, cancellation, bounded buffering and cleanup; no generic
stream or WebSocket is part of this pilot.

## Required evidence before claiming the slice works

- Backend: atomic login/device/session issuance, owner/device/session binding,
  rotation race and replay rejection, revoked and expired tokens, logout,
  cross-device misuse, no-store and secret redaction, on SQLite and PostgreSQL.
- Rust: fixed route and schema enforcement; traversal/encoded path and
  unexpected method/header/query rejection; origin change, TLS verification,
  redirects, proxy, loopback policy, timeouts and bounded responses; concurrent
  refresh; crash/rotation and Keychain failure; logout failure and secret-free
  errors/logs. Exercise real OS Keychain with isolated test entries and cleanup.
- End-to-end: isolated backend and synthetic owner, real packaged app login,
  Tasks/Projects read and write, conflict, logout/revocation, offline and
  recovery, quit/reopen with Keychain persistence, and failure between server
  rotation and local persistence. Rebuild after the final shared asset refresh.
- Keep full agent transcripts local; retain fail-closed runtime and verify that
  no native auth work enables agent execution. Sleep/wake and comprehensive
  platform performance remain separate acceptance checks.
