# Android native authentication feasibility proposal

2026-10-30 · Phase 0 Tauri Android spike · **proposal only, not implemented or
security-verified**. Android wrapper ADR-006 remains PROPOSED. This assessment
uses the current checkout; backend and shared-client changes belong to their
owners. No UI, permission, network, CSP, TLS or auth settings were changed.

## Findings in this checkout

1. `POST /api/v1/auth/login` returns access and refresh tokens, but creates an
   `AuthSession` with **no device_id**. `POST /api/v1/auth/refresh` rotates that
   session and keeps its optional device_id; it cannot bind an owner-only login
   to Android. `POST /api/v1/auth/logout` requires a valid access bearer and
   revokes that session. `GET /api/v1/me` returns the principal's device_id or
   null. See `backend/app/core/api.py`, `security.py`, `models.py`.
2. `POST /api/v1/devices/enroll`, authorized by an owner bearer, accepts
   `{platform, display_name, public_key?}` and returns `{device_id, credential,
   access_token}`. Its session stores a hash of an unrelated random value, not
   a usable refresh token. A repository search found no exchange endpoint for
   `credential`; it must not be assumed to support device login. The returned
   device access token expires, with no renewable device session. Revoking via
   `POST /api/v1/devices/{device_id}/revoke` causes principal checks to reject
   bearer tokens for that device. The public key is optional and no device
   proof of possession is established by enrollment.
3. Browser `/api/v1/auth/browser/{status,login,bootstrap,refresh,logout}` uses
   a Strict HttpOnly refresh cookie, `X-Aelys-Browser`, origin and cross-site
   checks. Browser login creates a **web** device. Backend grants no credentialed
   CORS. `apps/web/src/lib/api.ts` uses those browser endpoints and browser fetch;
   `packages/shared/src/api-client.ts` injects a bearer into an injectable
   `fetch` implementation. Supplying a remote URL alone therefore does not make
   browser-cookie login or cross-origin bearer requests work on Android.
4. Mobile currently registers only `runtime_policy`; there is no secure storage,
   native HTTP transport or native auth command. `core:default` is the existing
   capability. Do not infer any isolation or platform behavior from its name.

## Tauri origin and execution boundary

For this checkout the packaged Android app is expected to use
**`http://tauri.localhost`**, not `https://tauri.localhost`: its window config
omits `useHttpsScheme`, whose default is false. Tauri documents the mapping and
warns that changing the scheme changes browser storage origin. The dev URL is
separately configured as `http://127.0.0.1:5173`; Android's loopback is not the
Mac. Confirm the actual packaged and dev WebView origins on an emulator or
physical device; no APK exists yet. The protocol is an internal WebView asset
mapping, not a TLS connection to the backend, a network-wide trusted origin, or
a vendor identity proof. Enabling HTTPS for the custom scheme alone cannot fix
CORS or make an HTTP backend secure. See [Tauri configuration](https://v2.tauri.app/reference/config/) and [Tauri's protocol change](https://v2.tauri.app/release/wry/v0.33.0/).

## Smallest candidate design

The following names are proposed, not existing contracts. First agree on typed
server contracts and security tests with the backend owner; neither the browser
cookie endpoints nor existing owner-only refresh token are substitutes.

- `POST /api/v1/auth/native/login`: verify owner credentials and atomically
  create an Android Device and a session bound to it, returning a short-lived
  bearer, one rotating refresh token, device ID and expiry to **native code**.
  If first-owner setup on Android is required, a separate native bootstrap must
  reuse the existing serialized owner-initialization lock. Otherwise require an
  already initialized owner. The existing enrollment route cannot provide this.
- `POST /api/v1/auth/native/refresh`: accept the refresh secret in a JSON body
  over verified HTTPS; validate token type, expiry, owner, session, device match
  and revocation; atomically rotate the hash. Serialize client refreshes. Specify
  whether session identity remains stable so refresh does not accidentally revoke
  unrelated in-flight access tokens. Reject replay. Explicitly design the lost
  response/process-crash case: after a server rotation succeeds but before the
  client durably saves the successor, require reauthentication unless a separately
  reviewed safe recovery protocol exists. Never blindly replay an old secret.
- `POST /api/v1/auth/native/logout`: revoke the native session using a valid
  refresh credential even when access expired, with idempotent safe handling;
  retain an offline sign-out marker and erase local secrets immediately. Offline
  logout cannot promise server revocation; document that limit. Revoke device
  separately through the existing owner-authorized endpoint.

Credentials are bearer secrets **associated with** a device record; they are not
cryptographically device-bound merely because a device ID appears in JWT claims.
Proof-of-possession, enrollment approval, authentication throttling and a recovery
flow need explicit design and tests, not an assertion of current support.

Native layer: add narrowly typed commands such as `native_session_login`,
`native_session_resume`, `native_session_logout`, and a non-secret
`native_session_status`. Their inputs select only the configured backend and
relevant fixed auth operation; outputs must omit refresh tokens and passwords.
Keep refresh secret in a Rust-controlled native session component with an Android
Kotlin/Java bridge using a non-exportable Android Keystore key to encrypt an
app-private record in `noBackupFilesDir`; do not expose generic secret read/write
commands to JS. Use authenticated encryption with unique nonces, fail closed on
key loss/decryption error, and test backup/restore, reinstall and invalidation.
Keystore protects key extraction, not a compromised application process; do not
claim hardware backing without checking the device. Tauri documents
[Rust-to-Kotlin mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/);
[Android Keystore](https://developer.android.com/privacy-and-security/keystore)
protects cryptographic keys rather than storing arbitrary token strings, and
[Android backup rules](https://developer.android.com/identity/data/autobackup)
exclude `noBackupFilesDir`. Native plugin commands must not also be directly
available to JS unless individually authorized and safe. Explicitly verify Tauri
application-command ACL behavior: app commands registered with `invoke_handler`
can be callable unless restricted; expose only intended commands to the local
main window and prohibit remote content/navigation from invoking them. Test this
against the actual release build, not just the capability JSON.

Backend endpoint configuration needs an explicit trusted HTTPS origin, ordinary
certificate and hostname validation, no userinfo/query/fragment, strict URL
canonicalization, bounded redirects (prefer none), timeouts and size limits. Bind
each stored session to that exact origin; changing origin clears/signs out the
old session before any credentials can be sent. Password entry crosses the WebView
IPC transiently if the existing shared login screen is reused; this protects the
refresh token from JS persistence but does **not** protect the password or an
access token from compromised WebView code. Passwords, tokens, request bodies
and response headers must not enter logs, outbox, cache, telemetry or errors.

## Shared client transport is a separate requirement

To avoid both cross-origin browser fetch and a general HTTP proxy, the native
adapter must expose **typed, explicitly enumerated domain operations** that map
to fixed backend routes and methods under the bound origin; validate each input,
encode IDs and query parameters, reject absolute URLs, arbitrary headers,
redirects and paths, and use native TLS. This is an operation surface as broad
as the actual product operations, not a single generic URL/method/body command.
It is substantial: include health/status, auth, CRUD/sync, and separately design
streaming/SSE and cancellation. A generic `fetch` shim to arbitrary paths would
recreate the unrestricted proxy the task excludes. Where a limited pilot omits
operations, fail explicitly and do not advertise full mobile functionality.

The parent can introduce a typed transport/session interface in the shared web
API, retaining its browser implementation unchanged and routing Android to the
native adapter. Decide consciously whether short-lived access bearer crosses IPC:
keeping it entirely native reduces JS exposure and requires native domain calls;
returning it to JS still needs a safe CORS solution and exposes it to WebView
compromise, so it is not the recommended candidate here. Preserve stable
idempotency keys, durable outbox and existing online-only constraints; do not
retry an ambiguous write or queue login/refresh/logout. Handle 401 refresh once,
single-flight with an origin/session generation check, and preserve cancellation,
response/error typing and streaming semantics.

## Verification gates before claiming native auth

- Server: independent Android devices, valid/invalid credentials, single owner
  initialization races, device/session association, revocation, expiry, rotation
  replay and concurrent refresh, logout after access expiry, cross-device and
  cross-owner token rejection, SQLite/PostgreSQL transaction behavior.
- Native: release APK on device; Keystore persistence/restart, key loss, backup
  exclusion, sign-out offline, process interruption during rotation, origin
  changes, invalid certificates, redirects, malicious paths, remote-window IPC
  denial, no credential leaks. Confirm protocol origin, WebView CSP and permissions.
- End-to-end: isolated backend and synthetic owner, device enrollment/session,
  login, restart/refresh, CRUD and revocation, offline/resume, retry/idempotency,
  and SSE if advertised. Record APK and device/ABI. Until NDK license review,
  APK and device gates remain blocked; design feasibility is not validation.
