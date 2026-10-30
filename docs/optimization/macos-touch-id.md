# macOS Touch ID session unlock

Task: IMPLEMENTATION_PLAN Phase 1, auth/device foundation. The owner explicitly
requested an optional macOS Touch ID toggle. This does not change the platform
ADR, agent sandbox, backend login/device permissions or Android wrapper decision.

## Implemented behavior

Settings → Безопасность exposes a native-backed Touch ID switch on macOS.
Enabling asks LocalAuthentication to evaluate biometrics, and persists the
origin-scoped enabled policy in the existing OS Keychain only after success.
After process restart, native status reports `biometric_locked` without reading
the refresh credential. AuthGate shows an explicit unlock button instead of
prompting automatically. `native_resume` enforces the policy in Rust before
reading/deleting/rotating the stored credential. Cancellation, unavailable
biometrics and policy-read errors preserve the saved record and live session.
No WebView preference can bypass native resume authorization.

Account-password sign-in remains a server-verified fallback. A failed password
or network request no longer deletes the saved refresh record. After an
already authenticated owner disables the switch, later opens use the previous
session-restoration behavior. Disabling remains possible after biometric
enrollment is removed; it requires an authenticated native session, not another
fingerprint. Settings reads serialize with changes so remounting during a prompt
observes its completed result. Backend-origin changes invalidate late UI results.

This is an application session-unlock policy; it does not migrate Keychain
items to biometric access-control ACLs. Existing refresh credentials remain in
OS Keychain. No passwords, refresh tokens or biometric data are returned by
these new IPC commands. Apple handles the biometric comparison through
[LocalAuthentication](https://developer.apple.com/documentation/localauthentication/lacontext).
The small ObjC bindings use existing locked objc2/block2 versions, without a new
biometric SDK or subprocess. Availability is checked afresh; it is not cached.

## Scope and verification

The option applies on process restart. Automatic locking on sleep, loss of
focus or inactivity is outside this slice. Android reports unsupported and does
not grant the biometric-setting mutation ACL. Browser-only sessions do not show
the native setting. The native entry also no longer displays Android-only
loopback/HTTPS guidance on macOS.

- Web: 178 tests pass; TypeScript and production build pass.
- Shared native transport: 25 tests pass, one opt-in hardware test skipped by
  default. New regressions cover denied/cancelled authorization preserving
  refresh/session/stream state, successful authorization consuming the old token
  exactly once, and a real loopback HTTP 401 preserving password-fallback storage.
- The opt-in macOS availability test was run separately: real framework probe
  returned `Touch ID currently available: true`, without opening a prompt.
- Native fmt and Clippy (`-D warnings`) pass.
- The current unsigned arm64 `.app` built successfully (27.49 MiB); quit/reopen
  visibly reaches the native login screen. Its identity is recorded in
  MACOS_OPTIMIZATION_STATUS.md.
- Android-target `cargo check` passes with the Rustup toolchain and the NDK
  compiler/archiver configured. This does not replace APK/device acceptance.

Fingerprint approval, cancellation of the real system prompt, persisted toggle
across signed-in app restarts and recovery after enrollment changes still need
an owner interaction. Neither mocked UI tests nor the hardware-availability
probe claim these acceptance gates. No personal account, credentials or
Keychain policy was modified by the tests. No commit, push, deployment or
signing identity was created.

## Repeated Keychain permission prompts (owner-reported follow-up)

Selected task remains Phase 1 auth/device, scoped to macOS session restore.
The owner observed two password permission windows for the Touch ID service.
The previous implementation read the `enabled-v1` marker as credential data
from status, resume, and settings readback. Those reads could request OS
permission before LocalAuthentication ran. A changed development build can
also require separate Keychain access permission; this is not a rejected
fingerprint or proof that the owner's Mac password is wrong.

The policy now checks exact service/account metadata only. An existing policy
record keeps the gate enabled, even if its payload is malformed; permission
errors fail closed. macOS native status checks session presence without reading
the refresh token and never inspects Keychain for an already active session.
No saved token means there is no Touch ID restore action, even with a policy.
`SecItemCopyMatching` lookups explicitly disallow authentication UI, execute on
blocking workers, and return `KEYCHAIN_ACCESS_REQUIRED` when denied. Explicit
resume still runs LocalAuthentication before reading/deleting/rotating the
credential. Credential-read failure preserves live session and subscriptions.
Keychain errors show a dedicated, redacted notice in entry/settings instead of
being mistaken for server failure. Successful writes and toggles still require
OS permission; no ACL changes or Keychain reset are attempted.

Validation for this follow-up:

- `pnpm --filter @aelys/web typecheck` and `test`: pass, 196 tests in 31 files.
- `cargo test --offline --manifest-path packages/native-transport/Cargo.toml
  --lib`: 30 passed, two opt-in probes ignored by default.
- Native Clippy `--all-targets -- -D warnings` and fmt check: pass.
- Opt-in read-only policy metadata probe on the owner's Mac: `Ok(true)` in
  0.01 seconds, without requesting credential bytes or opening an auth prompt.
- Query regressions assert attributes-only status and authentication UI denial;
  transport regressions cover metadata-only status, no-secret active sessions,
  fail-closed denied presence, and preserved session/streams on denied reads.
- UI regressions cover denied status, automatic/explicit resume and password
  fallback, with protected data hidden and the settings switch authoritative.

Real fingerprint approval, subsequent refresh rotation and restart remain
owner-interaction acceptance gates. The local app remains unsigned; this fix
cannot promise trust for old Keychain records across all rebuilt binaries.
There is no silent fallback to unprotected storage and no new signing identity.

Owner clarified that the real Touch ID prompt did appear, followed by a
Keychain password request. The first follow-up suppressed reads only; credential
rotation still used standard Keychain update/delete, which can also request
permission. All Aelys Mac Keychain operations now use a serialized scoped
`SecKeychainSetUserInteractionAllowed(false)` guard, including update/delete,
and restore the previous process setting on return/error. This denies implicit
UI rather than granting access or bypassing ACLs; LocalAuthentication is outside
the guard. A repeated enable on an existing policy no longer rewrites it.
A real-framework regression verifies interaction is disabled inside the scope
and restored after error. An owner-observed follow-up reached the dedicated
Keychain denial notice; it did not complete authenticated restore.

Read-only signing checks: `security find-identity -v -p codesigning` found zero
valid identities. `codesign -d -r-` showed a cdhash designated requirement,
not a stable certificate identity. This supports rebuilt-binary trust as a
possible cause of the old-record permission denial; locked Keychain/ACL state
is not conclusively diagnosed. Do not infer a wrong Mac password or delete the
owner's saved Keychain entries. A certificate-backed signed build and owner
Keychain authorization are outstanding before claiming seamless Touch ID
restore. This agent did not create a certificate, change ACLs, reset Keychain
or handle the owner's password/fingerprint.

Android target regression check passed after supplying the installed NDK's
`CC_aarch64_linux_android` as well as linker/archiver; an initial attempt without
the CC variable failed in ring tool discovery. No SDK or security change was
needed. The latest unsigned .app rebuild passed. The saved personal account,
credentials, policy and server DB were not modified by validation.

## Explicit Keychain recovery (owner follow-up)

The previous fail-closed handling left the owner without an in-app way to
request trust for the current binary. An explicit recovery button now calls
`native_keychain_authorize(origin, scope)` for exactly one fixed Aelys service
(`session` or `touch_id_policy`). Rust validates the main window and bounded
origin, serializes with auth commands and other Keychain access, permits the
OS permission UI only during that exact read, and restores the previous
process interaction setting afterwards. It returns only item presence; no
credential is returned, rewritten, deleted, refreshed, or used to authenticate.
It never changes ACLs itself. The command is registered only on desktop; Android
has no handler or permission for it. Normal background reads and writes continue
to suppress authentication UI. The owner completes any OS password/trust prompt.

AuthGate and Touch ID settings show the button only after the safe permission
error. Entry rechecks status after permission but does not automatically resume;
Touch ID is still a separate explicit action enforced in Rust. Settings rechecks
the authoritative status and does not automatically reapply a toggle. Pending and
cancelled recovery preserve entry and settings state and remain retryable.

For this development build the owner may choose Always Allow in the macOS
permission prompt; see Apple's explanation of [Keychain access](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26).
This is permission for the existing item, not a guarantee of persistent trust
across unsigned/ad-hoc binary rebuilds. No owner password or system authorization
was entered or approved by the agent. Real successful owner permission + Touch
ID restore remains an acceptance gate.

Recovery validation: 201 web tests in 31 files passed before the final small
policy-label correction; its focused AuthGate suite (11 tests) then passed.
The native crate has 32 passing tests and two ignored opt-in probes, including
scope allowlisting and real-framework scoped interaction restoration. Native
Clippy/fmt and Android-target check passed; desktop release rebundle passed.
The final frontend condition sends a recovered session with biometrics off to
password entry instead of claiming Touch ID is enabled, with a regression test.
