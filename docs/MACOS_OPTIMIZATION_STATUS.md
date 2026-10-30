# macOS desktop build and measurement status

Latest artifact (2026-10-30): unsigned arm64 `.app`, 27.61 MiB, executable
SHA-256 `a3abde656b3673a39a69e861a255080ab16255b5126bd6d24b36455ac69e414f`.
Shared native transport tests: 32 passed (two opt-in probes ignored by default); Android session-store contract: 1
passed; fmt/Clippy and release bundle build passed. Web: 202 tests and
typecheck passed. AI events now use an incremental Tauri Channel;
AbortSignal/reader cancellation closes the native HTTP subscription, including
before backend headers. Session changes cancel affected subscriptions. See
[streaming evidence and limits](optimization/native-ai-streaming.md). Singular
Projects/Notes writes and Focus start/stop response parsing were corrected
after three failing HTTP regressions; list parsing is preserved. See
[domain response evidence](optimization/native-domain-response-contracts.md).
The session
mutex no longer blocks cancellation/logout during an AI event response, with
loopback HTTP regression evidence in
[native-ai-cancellation.md](optimization/native-ai-cancellation.md).
The latest Keychain follow-up rebundle is build-verified. Native AX confirmed
the explicit Touch ID entry without startup password windows; screenshot capture
failed (ScreenCaptureKit -3811). The owner reported successful fingerprint
prompt followed by a separate Keychain password prompt; denied access now
shows its own notice. All native Keychain reads/writes/deletes suppress implicit
authentication UI and fail closed instead. No certificate-backed signing identity
is installed. Authenticated restart remains unverified, not complete. See
[Touch ID follow-up evidence](optimization/macos-touch-id.md) and
[component evidence](COMPONENTS.md).

The current rebundle used the generated `apps/web/dist` after the Touch ID
slice and was built with:

```sh
pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app --config '{"build":{"beforeBuildCommand":"","frontendDist":"../../web/dist"},"bundle":{"active":true,"targets":["app"]}}'
```

The build completed successfully. The fresh `.app` was quit/reopened through
the native UI and visibly reached the login screen at `tauri://localhost`, with
the updated session-confirmation copy. LocalAuthentication reports Touch ID
available on this Mac. Fingerprint approval and authenticated restart remain
unverified; the owner must sign in once and enable Settings → Безопасность →
Touch ID. See [scope and validation](optimization/macos-touch-id.md).

2026-10-30, Phase 1 / Foundation desktop shell verification. This is a local
build and baseline, not completion of the platform optimization goal.

## Assumptions and open questions

- The refreshed shared web build is a point-in-time input; another frontend
  change requires a new web build and rebundle. No shared web source or dist
  was modified by this desktop work.
- The approved native backend connection and session transport are unresolved.
  The Mac CLI isolation question remains OPEN; vendor execution remains disabled.
- No personal database, credentials, signing identity, or legal agreement was
  used or changed. Tests below do not establish sandbox isolation.

## Artifact and build

Host: macOS 26.5.2 (25F84), arm64, Xcode Command Line Tools at
`/Library/Developer/CommandLineTools`, Rust/cargo 1.99.1, Node 26.5.0,
pnpm 11.18.0, Tauri CLI 2.12.4. Historical pre-existing unbundled release
binary was 17 MiB, SHA-256
`11430bcbfadb48bb35438773efb801bbd4e8586599fa6d8f0893ad9c182ac1e5`;
it is not evidence for the current app.

Current release app: `apps/desktop/src-tauri/target/release/bundle/macos/Aelys.app`
(23.79 MiB reported by Tauri; arm64). The executable SHA-256 is
`bf7a9a4ceb49623a05a9ff8ce385e875007393e5ab8d936356cd7b5cf55061a5`.
The build explicitly used `--no-sign`: `codesign -dv` on the first build
reported a linker ad-hoc signature, no team, and no sealed resources. This is
not Developer ID signed or notarized, and the `.app` is not an installer.
No DMG was built.

The first isolated Vite build was followed by a shared frontend refresh. The
final bundle used a separate copy of the refreshed `apps/web/dist`, whose
`index.html` SHA-256 was
`51bd720895bdcd3680317fffc43290845ff0dabfbf4ea0ee9f1154c982f4a00f`.
`diff -qr` showed that copy and the shared dist matched after bundling.
Rebuild after any subsequent frontend changes. To reproduce, after the shared
frontend build is complete, choose a fresh temporary path and run:

```sh
cp -R apps/web/dist /tmp/aelys-desktop-frontend-refreshed-20261030
pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app --config '{"build":{"beforeBuildCommand":"","frontendDist":"/tmp/aelys-desktop-frontend-refreshed-20261030"},"bundle":{"active":true,"targets":["app"]}}'
```

The configured default `bundle.active` remains false; the override applies only
to this command. The build took 34.24 s (incremental release compilation).
Launch the app using Finder or the computer-use app launcher.

## Observations and measurements

The refreshed bundle opened to `tauri://localhost` and showed “Сервер
недоступен”; the earlier bundle's server address field showed `/api/v1`.
The production frontend uses that relative default and has no Vite dev proxy at
the Tauri origin. The browser session transport expects same-origin requests;
an arbitrary absolute URL also requires a compatible CSP, CORS, origin and
cookie/auth design. A functional native login/backend connection is not proven.
This needs coordinated shared frontend/backend work, not a CSP relaxation here.

Three sequential CUA `getApp` calls after quit measured 2787, 696 and 874 ms
wall-clock. These include launcher/automation overhead and are **not** precise
process-to-interactive measurements: the first returned an empty window tree,
then a separate AX observation showed the error screen. No cold boot or
authenticated screen was measured.

On the refreshed build, with the error screen idle and other development work
running, `ps -p <app-pid> -o pid,%cpu,rss,etime` sampled the main app process at
5-second intervals (elapsed 14, 19, 24 seconds): CPU 0.0%, 0.0%, 0.0%; RSS
80,656, 70,944, 71,344 KiB. These are point samples, not a CPU time average;
WebKit XPC processes are not attributed and are excluded, so this is not total
app memory/CPU. An earlier frontend snapshot gave 0.0% CPU and 83,088, 74,880,
72,336 KiB RSS at elapsed 10, 15, 20 seconds; the builds differ, so no
performance improvement is claimed. Repeat on an otherwise quiet host with
attributed WebKit processes and a working authenticated screen.

## Checks and remaining work

- `pnpm --filter @aelys/web typecheck`: passed on the current checkout.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`: passed.
- `cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`: passed.
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`:
  passed, but executed **zero** unit or doc tests; it is not functional coverage.
- The app was quit and reopened twice and showed the unavailable screen again.
  Backend calls, authenticated session persistence, CRUD, offline recovery,
  sleep/wake, child cleanup and full process resource usage remain unverified.
- Next: establish an authorized native API/auth path with the shared/backend
  owners, rebuild after their final frontend refresh, then repeat measurements
  and lifecycle tests using an isolated backend and synthetic user data.

## Native session pilot follow-up (2026-10-30)

The bounded native auth/backend slice is now implemented and tested. Rust owns
native login, resume, logout, Keychain persistence, origin validation and a
fixed typed operation allowlist; the WebView receives only sanitized status and
domain results. No generic native fetch proxy, arbitrary path, redirect, token
or password output was added. Backend `/api/v1/auth/native/*` is cookie-free,
rejects browser Origin/Fetch-Metadata headers, rotates refresh hashes atomically,
and binds sessions to a native macOS/Android Device record. The web adapter is
wired into AuthGate and the shared client for the typed Me/Projects/Tasks pilot;
other module clients remain unsupported by design.

Current release rebundle after this slice: Tauri reported 25.69 MiB, arm64;
executable `apps/desktop/src-tauri/target/release/bundle/macos/Aelys.app/Contents/MacOS/aelys-desktop`, SHA-256
`3b67010d6b11b7f65991246af62d428d7f5fd9868991142f3054372da1a23d7e`.
`cargo check --locked`, `cargo fmt --check`, and `cargo test --locked` passed;
Rust tests: 7 passed. The app launched as an unsigned local `.app`; codesign
verification is not a release acceptance gate until an owner signing identity
exists. Keychain persistence and authenticated app restart require a live
interactive native test and remain open.

## Native Home read follow-up

The typed native operation allowlist now includes explicit response schemas for
Home notes, calendar occurrences, finance transactions, focus sessions, mail
messages and activity. Latest unsigned arm64 rebuild: 25.89 MiB, executable
SHA-256 `612783c4a7498d784cc22d00a08feccc6e860c730da961e45503b1ce4d48f793`.
The app process was relaunched from this bundle. Owner-authenticated Keychain
restart and remaining module writes are still unverified.

## Native Notes write follow-up

The bounded native allowlist now includes Notes create, versioned patch and
soft-delete operations with strict input validation. Latest rebuild: unsigned
arm64, 25.95 MiB, executable SHA-256
`20ed032cda9471ec07c1c659c214497c8b1cf7dac9513aaf1b03068624a3f9df`.
Authenticated Keychain restart and remaining module write operations remain
unverified.

## Native Finance read/write follow-up

The bounded native allowlist now includes Finance accounts, categories, budgets,
summary and transactions reads, plus account/category/transaction creates.
Decimal values stay strings across the IPC boundary. Latest unsigned arm64
bundle: 26.16 MiB, executable SHA-256
`8140bcfcfdfdeab5f35f4d1202d7bc0f94da6bcbd2f1c10eb5957e0a2569b58e`.
Transfers, budget writes and authenticated Keychain restart remain open.

## Native Calendar write follow-up

The bounded native contract now includes Calendar event list/create/versioned
update/versioned soft-delete with explicit UTC/IANA/RRULE fields. Latest
unsigned arm64 bundle: 26.16 MiB, executable SHA-256
`8eb96c3fe5d19f9f637a303db2ecca0eb4256cb38d909d966faf08e6cefd402f`.
Calendar reminders, Focus writes and Keychain restart remain open.

## Native Focus lifecycle follow-up

The bounded native contract now includes Focus read, idempotent start and
versioned stop. Latest unsigned arm64 bundle: 26.20 MiB, executable SHA-256
`dec1f0898152d52b7aa54786da705294dcfc11f37ca4db6e6201bf03806b198d`.
Focus reminders/policy behavior, remaining module writes and Keychain restart
remain open.

## Native Calendar reminder follow-up

The bounded native contract now includes reminder list/create/versioned cancel
with strict event binding and idempotency fields. Latest unsigned arm64 bundle:
26.26 MiB, executable SHA-256
`91a730d84c67ccb8e67f45feee846acb57be660a37bb694f886c8d7805f269f6`.
Policy-aware dispatch, remaining external module writes and Keychain restart
remain open.

## Native Finance transfer/budget follow-up

The bounded native contract now includes strict budget create and balanced
transfer create operations with Decimal strings and idempotency keys. Latest
unsigned arm64 bundle: 26.32 MiB, executable SHA-256
`c8b51f0b05ba502590744046f10a9a832a8a6671276a77dc5d85dc7e0e55a102`.
Authenticated Keychain restart and remaining external integration writes remain
open.

## Native local Mail drafts follow-up

The bounded native contract now includes local draft list/create/versioned
patch/delete. Gmail OAuth/account connection and sending remain outside this
IPC boundary. Latest unsigned arm64 bundle: 26.36 MiB, executable SHA-256
`916da5354cfcaa4272177ef379a6f764633e308b1ef8dbb5c8bd4e0428e4f900`.
Keychain restart and credentialed external integration behavior remain open.

## Native Mail read boundary follow-up

Native Mail now reads owner-scoped account metadata and non-secret Gmail status;
OAuth connect/send remain outside the IPC allowlist. Latest unsigned arm64
bundle: 26.39 MiB, executable SHA-256
`e282993b0cc8f58abc4610542623aa42274c6148dd560d604f5e837725f8115c`.
Keychain restart and credentialed integrations remain open.

## Current evidence reconciliation

The earlier “server unavailable” observations belong to the pre-native-auth
bundle. The current bundle is unsigned arm64 26.39 MiB with executable SHA-256
`e282993b0cc8f58abc4610542623aa42274c6148dd560d604f5e837725f8115c` and the
React entry uses native health/auth plus the typed allowlist recorded in
`NATIVE_TRANSPORT_VALIDATION.md`. A native login screen was visibly reached in
the immediately preceding unlocked CUA run. The final process was relaunched
while the Mac was subsequently locked; owner-authenticated Keychain restart,
sleep/wake and complete module acceptance remain unverified.

## Native AI read boundary follow-up

Native AI reads provider metadata without secret values, conversation lists and
messages. Secret writes/probes, AI runs and streams remain outside IPC. Latest
unsigned arm64 bundle: 26.46 MiB, executable SHA-256
`12de3d3a7b8fc4b93e943fdbaed4c7dac537f85e8a99661c7b2c99fd3049fa3f`.
Keychain restart and credentialed AI execution remain open.

## Native AI conversation writes follow-up

Conversation creation and message creation now use explicit typed IPC variants
with bounded input validation. Provider secret values, secret mutation/probe,
model execution and streaming remain outside the native bridge. Rust fmt/check,
Clippy and tests passed (7 native tests); the web suite passed 157 tests and
typecheck. Latest unsigned arm64 bundle: 26.51 MiB, executable SHA-256
`f9b7a2fe73d0f511be902a2ba049d62a35ba5640d8e38e367c2a2749ca36f157`.

The subsequent native enum correction rebuilt the same unsigned arm64 app at
26.51 MiB, executable SHA-256
`0acc2f6f325a442c558cddb8301e0a9d00f1b83d0be5e7142eba00c3c73f0c7e`.
Eight native tests pass. The unrelated Juz40 process currently owns port 8000;
the Aelys backend was validated on loopback port 8001 instead, with health OK.

## Native Projects and Notifications follow-up

The typed native surface now includes owner-scoped project create/versioned
patch/delete, notification list/read and in-app reminder dispatch. Web tests
pass 158 and Rust native tests pass 9. Latest unsigned arm64 bundle: 26.63
MiB, executable SHA-256
`4a3bf7afdc9bf62e40b12e540c2dc112b69fa89215ea2a38d5a33e719947207e`.

## Native AI execution follow-up

AI run create/get/cancel and allowlisted SSE event delivery now use typed native
operations. Rust tests pass 11 and the Web suite passes 159. Latest unsigned
arm64 bundle: 26.71 MiB, executable SHA-256
`b330033d07c87b8d2a3e55d1fa8f967f8b7c7d6be05104d73ce5f2069110068f`.
Provider secrets remain backend-only; credentialed execution and Keychain
restart still require owner-authenticated QA.

Explicit recovery follow-up: the entry/settings permission notice now offers
«Разрешить доступ macOS». This action requests OS permission for one fixed
Aelys session/policy item and returns presence only. It never logs in, resumes,
rotates credentials or toggles biometrics. Status is rechecked afterwards;
Touch ID remains explicit. Owner permission/fingerprint acceptance is still
open; no OS prompt was approved by the agent. See
[recovery behavior and checks](optimization/macos-touch-id.md).

The owner-requested entry redesign is now bundled: neutral canvas, centered
Touch ID/password form, concise Keychain recovery and secondary footer tools.
202 web tests, typecheck and build pass; real native Touch ID/password screens
and browser narrow/server-form layouts were inspected. See [design evidence](optimization/auth-entry-design.md).

The local integration gate and native sign-out/session-expiry corrections are
recorded in [the integration checkpoint](INTEGRATION_CHECKPOINT.md). Previous test counts above describe their dated slices.
