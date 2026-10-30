# Android APK build — Phase 0 viability spike, 2026-10-30

This closes the missing-toolchain/project/APK build gates and records the current
native transport/Keystore integration build. ADR-006 remains PROPOSED. Android
native authentication, secure session storage, typed transport,
device installation/startup, offline persistence, background/resume, permissions
and notification acceptance remain unverified. No complete Android module is claimed.

## Changes and reproduced problems

The owner installed Google's SDK packages in Android Studio: command-line tools
23.0 and NDK r30 (30.0.16248370). This agent did not accept agreements or write
license files. The build used JBR 21.0.11, SDK platforms 37 and 36, build-tools
36.0.0, Tauri CLI 2.12.4 / Rust Tauri 2.12.5, Gradle 9.6.1 and AGP 9.3.1.
Gradle installed platform 36 using the already accepted SDK license.

The first actual cross-build failed in `openssl-sys`: mobile depended on the
unused Mac-only `aelys-runtime`, which pulled native TLS/OpenSSL. Removing that
dependency pruned 54 packages (460 to 406) without adding/upgrading any remaining
locked package. The Mac runtime, its transport, sandbox and grants are unchanged.

Tauri's generated debug manifest substituted `usesCleartextTraffic=true`.
`apps/mobile/scripts/prepare-android.mjs`, invoked by `beforeBuildCommand`, now
sets a literal `false`, rejects unexpected network overrides/templates, and
keeps the packaged debug/release policy consistent. Both compiled APK manifests
were inspected, rather than trusting the source template alone.

A subsequent debug build contained **288,729,096 bytes** while its compressed
ZIP entries totaled **147,812,796 bytes**: about 140.9 MB was unused archive space.
Repackaging the same source from a fresh generated APK returned **147,989,304
bytes**, with unchanged entries and native payload, about **48.7% smaller**.
The debug build hook now moves only the previous generated universal debug APK
to `.apk.previous` before packaging. A real hooked rebuild retained the previous
file and produced the same 147,989,304-byte size, with 176,508 bytes of ZIP
overhead. Release archives and files outside that generated debug path are not
rotated. This is a locally reproduced incremental-packaging workaround, not an
assertion about every AGP version. Hook flags follow
[Tauri's documented build environment](https://v2.tauri.app/reference/config/#beforebuildcommand).

## Current integrated artifacts on this Mac

| Variant | File under repository root | Bytes / MiB | Signature |
|---|---|---:|---|
| arm64 debug spike | `output/android/aelys-arm64-debug-spike.apk` | 202,017,354 / 192.66 | Android Debug certificate, APK v2 verified |
| arm64 release spike | `output/android/aelys-arm64-release-unsigned-spike.apk` | 32,387,444 / 30.89 | Unsigned; not installable as-is |

Debug SHA-256:
`04ef4f4cd8b8937f0542c8327a90a24b3fa0cff14d9402aad6fbf7f751fa914d`.

Release SHA-256:
`9c696d464d9c3460b853470b0ea111957dd9fced2771acfe6fb713d5093f5d4a`.

Machine-readable current evidence is `output/android/build-evidence.json`.
These generated artifacts are ignored by Git. Original Gradle outputs are
`apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/{debug,release}/`.
The size difference between debug and release is a variant comparison, not a
controlled optimization improvement. The debug build includes Rust debug symbols.

## Physical-device smoke check

The owner connected a Samsung **SM-S721B** (`R5CXB12V92Z`), arm64, Android API
36. The release artifact was signed locally with the Android debug keystore only
for this device check; it is not a production release signature:

`output/android/aelys-arm64-release-local-debug-signed-ux.apk`

Size: 32,446,727 bytes (30.94 MiB). SHA-256:
`04eaa818194682c27930d3333ab7f59f32992e2b3cd77c92a9f310913a16e793`.

`adb install -r` succeeded, `MainActivity` became the resumed activity, the
process survived a force-stop/relaunch, and a screenshot is saved at
`output/android/device-release-ux-launch.png`. The screenshot showed the
localized server-unavailable state; the server address control is now laid out
on its own line on a narrow phone viewport. Filtered logcat showed no
`AndroidRuntime`, Chromium or Aelys native fatal error. Backend login/CRUD was
not claimed because the phone still has no authorized HTTPS backend endpoint;
Mac `127.0.0.1` is the phone's own loopback.

## Executed checks

With process-local `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` and Rust PATH from
the [mobile README](../../apps/mobile/README.md):

- `pnpm --filter @aelys/mobile exec tauri android init --ci --skip-targets-install`
  — pass; real Gradle project generated.
- `pnpm --filter @aelys/mobile tauri:android:build --apk --target aarch64 --debug --ci`
  — pass, including the fresh-archive hook integration run.
- `pnpm --filter @aelys/mobile tauri:android:build --apk --target aarch64 --ci`
  — pass; optimized release library and unsigned APK produced.
- `pnpm --filter @aelys/mobile test` — 4 tests pass: template hardening,
  unexpected-policy denial, recoverable debug archive rotation and release/
  manual/other-platform isolation.
- `cargo test --locked --manifest-path packages/native-transport/Cargo.toml
  --lib` — 22 tests pass, including exact Android origin/TLS policy and the
  existing typed operation/stream/cancellation regressions.
- `cargo test --manifest-path packages/android-session-store/Cargo.toml` — 1
  Rust origin contract test passes. The isolated Gradle task
  `:tauri-plugin-aelys-session-store:compileDebugAndroidTestKotlin` passes;
  instrumentation tests are compiled but not run without a device.
- `cargo fmt --manifest-path apps/mobile/src-tauri/Cargo.toml -- --check` — pass.
- `cargo clippy --locked --manifest-path apps/mobile/src-tauri/Cargo.toml
  --target aarch64-linux-android --lib --features custom-protocol -- -D warnings`
  — pass on the actual Android target.
- SDK `apksigner verify --verbose` — debug verifies under v2. The release check
  fails as expected with missing signing metadata; no release signature is claimed.
- SDK `aapt dump badging` / `dump xmltree ... AndroidManifest.xml` — package
  `com.aelys.mobile`, only native ABI `arm64-v8a`, min SDK 24, target SDK 37,
  `usesCleartextTraffic=false` for both; release is not debuggable. Permissions
  are INTERNET plus AndroidX's app-scoped signature receiver permission.
- SDK `zipalign -c -P 16 4` — pass for both APKs. NDK `llvm-readelf -lW` shows
  all three ELF LOAD segments aligned to 0x4000 in each native library. This
  checks artifact alignment, not actual 16 KB-device runtime compatibility.
- `adb devices` — Samsung SM-S721B/API 36 is connected. Local release install and
  relaunch passed; the screenshot is recorded above. No backend CRUD, Keystore
  persistence/invalidation, offline sync or startup latency measurement is claimed.

Tauri/AGP emit upstream deprecated DSL, Java 8 target and Android API warnings.
They were not hidden or bypassed; both build commands exited successfully.
Frontend builds also include the Notes save-notice fix (169 web tests and
production-browser evidence recorded separately).

## Next bounded platform slice

The shared web app now has the bounded native command surface on Android. The
typed Rust transport is shared with macOS, accepts only the exact packaged
Android WebView origin, uses normal TLS validation, and rejects arbitrary URLs.
The internal Android session plugin uses Keystore AES-GCM under
`noBackupFilesDir`; its storage commands have no frontend ACL permission. This
is implementation/build evidence, not device security evidence. Use an isolated
backend and synthetic owner for tests. The owner chose a physical USB phone;
authorize its USB-debugging connection before installation. Never enable blanket
CORS, cleartext, arbitrary native HTTP, or disabled TLS validation to pass this gate.

After the smoke check, the phone disconnected during a later rebuild. The latest
release APK includes the clearer Android HTTPS/loopback explanation and is at
`output/android/aelys-arm64-release-local-debug-signed-current.apk` (31 MiB,
SHA-256 `5361f630df9a2bf12ed338207628a21f1aa59752a606afe1adcbf6fe7a348a26`).
`adb install -r` succeeded after reconnection. The phone was locked during the
follow-up screenshot, so that screenshot is lock-screen evidence only. A
force-stop/relaunch of this current package completed and `pidof` reported a
live `com.aelys.mobile` process with no filtered fatal AndroidRuntime, Chromium
or Aelys lines. The foreground UI result above belongs to the preceding
release artifact.
