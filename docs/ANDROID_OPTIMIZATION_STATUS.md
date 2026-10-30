# Android Tauri spike status — 2026-10-30

Milestone: Phase 0 Android Tauri viability spike. ADR-006 remains PROPOSED;
notification, background sync, secure storage, offline persistence and APK gates
remain unverified. Assumption: an arm64 debug APK is the first local target; no
wrapper or auth architecture decision is implied.

## Toolchain and build evidence

**Current checkpoint:** the owner installed NDK 30.0.16248370 and command-line
tools 23.0 through Android Studio. Tauri Android initialization, arm64 debug and
release APK builds now pass, including the shared typed native transport and
Android Keystore session-store plugin. The debug APK is locally debug-signed;
release is unsigned. Exact hashes, sizes, manifest/alignment checks and commands are in
[Android APK build evidence](optimization/android-apk-build.md).

Device installation/startup, Keystore behavior on real hardware, offline
persistence, lifecycle and notification/background gates are still open. The
owner selected a physical USB phone; `adb devices` currently lists none.
ADR-006 remains PROPOSED. The earlier missing-SDK observations below are historical.

- Android Studio at `/Applications/Android Studio.app`; bundled JBR is 25.0.3.
  JBR 21.0.11 at `~/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home`
  is available and selected per command. SDK `~/Library/Android/sdk` contains
  platform-tools, emulator, platforms 34/35/37 and build-tools 34/35/36.
- Rustup initially had only the macOS target; `rustup target add
  aarch64-linux-android` succeeded. No global environment variables were changed.
- Historical pre-installation audit: the NDK and SDK command-line tools were
  missing, and Tauri initialization stopped at `Android NDK not found`. This is
  retained as the original baseline; it is superseded by the current checkpoint
  above and the build evidence document.
- `adb devices` returned no devices and `emulator -list-avds` returned no AVDs;
  no emulator was started or altered. Device tests, CRUD, lifecycle, permissions,
  WebView security and offline tests remain unverified.

The mobile library lacked Tauri's mobile entry point and now follows the
[official Tauri mobile example](https://v2.tauri.app/plugin/dialog/). This is a
startup prerequisite, not proof of a functioning Android binary.
`cargo fmt --manifest-path apps/mobile/src-tauri/Cargo.toml -- --check` and
`cargo check --locked --manifest-path apps/mobile/src-tauri/Cargo.toml` both
passed on macOS; the latter took 1m 04s and does not check the Android target.

## Integration risk and next safe action

The bundled frontend defaults to relative `/api/v1`, which resolves against the
Tauri WebView origin rather than the Mac backend. An API URL can be entered in
the auth gate, but browser authentication uses credentialed cookies, a custom
header and backend same-origin checks with no credentialed cross-origin CORS.
This needs a coordinated, explicitly scoped Android authentication/transport
solution and on-device tests; choosing a URL alone is not evidence of login.
Do not broaden CORS, auth, CSP, cleartext traffic or TLS validation to make the
spike pass.

Owner: review the current Android SDK license in Android Studio SDK Manager,
then, if agreed, install NDK (Side by side) and Android SDK Command-line Tools.
See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and
[Android NDK setup](https://developer.android.com/studio/projects/install-ndk).
Select an available compatible emulator system image only after reviewing any
additional license, or attach an authorized Android device. Then set JAVA_HOME,
ANDROID_HOME and NDK_HOME for the build process only, initialize Tauri Android,
build an arm64 debug APK, record its SHA-256 and signing status, and test it with
an isolated backend and data. Test release builds and all remaining viability
gates separately. Do not treat host `cargo check` as Android evidence.

## Historical prerequisite re-audit

Rechecked 2026-10-30 after the autonomous optimization slices: `sdkmanager`
was not found, no `ndk/` directory or `cmdline-tools/sdkmanager` exists, the
emulator list is empty, `adb` is unavailable and no Android project or APK is
present. The existing license file was not changed. This gate remains blocked
on an owner-reviewed SDK license plus installation of NDK/cmdline-tools and an
authorized emulator/device; host cargo checks are not Android evidence.

The old re-audit stopped before project generation with `Android NDK not found`.
It predates the owner installation and is not current build evidence.

## Mobile wrapper re-audit

The earlier wrapper audit below is historical. The current mobile build includes
the shared typed native transport and the Android Keystore session-store spike.
The transport has 22 Rust tests and an Android-targeted release build; the
session plugin has one Rust contract test plus compiled instrumentation tests.
The internal storage plugin has no frontend ACL grants and no JavaScript API.
This is still preparation evidence: no Android device installation, login,
Keystore restart/invalidation, backend CRUD, offline persistence or
background/resume behavior has been run.

## Current integration evidence

`apps/mobile/src-tauri` now registers the same fixed native command surface as
macOS and sends Android authentication (`platform=android`) through the shared
Rust transport. Android accepts only the exact packaged WebView origin and HTTPS
backend origins; there is no blanket cleartext/CORS/TLS exception. The session
store uses AES-GCM with a non-exportable Android Keystore key, origin AAD,
hashed filenames and `noBackupFilesDir`; uncertain writes leave a durable marker
and fail closed. Generated ACL evidence contains no permission for
`aelys-session-store` storage commands. These properties still require a real
release APK and USB-device validation.

The owner chose a physical USB phone. `adb devices` currently returns no device,
so the next action is to enable Developer options/USB debugging on that phone,
connect it, approve the RSA prompt, and tell the owner when `adb devices` shows
the authorized serial. Do not install or send data to an unverified device.
