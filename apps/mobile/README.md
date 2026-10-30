# Aelys mobile shell

This is the Android Tauri 2 spike target sharing the React web application.
The final mobile wrapper remains an open decision under ADR-006. This shell
does not claim Android support until Tauri Android initialization, APK build,
offline persistence and notification/background-sync checks pass on a machine
with Android Studio, SDK, NDK, Java and platform tools installed.

The mobile command surface deliberately has no vendor execution. Agent runs
remain Mac-only through the authenticated backend/runtime channel.

For a local arm64 build, select an installed JDK 21, SDK and NDK for this shell
only (the paths below describe this validation machine):

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/30.0.16248370"
pnpm install --frozen-lockfile
pnpm --filter @aelys/mobile exec tauri android init --ci --skip-targets-install
pnpm --filter @aelys/mobile test
pnpm --filter @aelys/mobile tauri:android:build --apk --target aarch64 --debug --ci
# Release artifact: unsigned until separately configured with an approved key.
pnpm --filter @aelys/mobile tauri:android:build --apk --target aarch64 --ci
```

Install `aarch64-linux-android` with rustup if missing; other ABI targets need
their corresponding Rust targets. Review SDK agreements in Android Studio first.
No command here accepts a new agreement. Generated Android files stay ignored;
the build hook reapplies the packaged cleartext prohibition after initialization.
It also retains the prior universal debug APK as `.apk.previous` so Gradle
packages a fresh archive without carrying unused native-library ZIP bytes.

The 2026-10-30 build produced real APKs; see
[artifact identities and verification](../../docs/optimization/android-apk-build.md).
The current app includes a native command/transport spike and an Android Keystore
session-store adapter, but neither has passed real-device security or login
acceptance. Installing or compiling it does not prove backend connectivity or
usable modules.
The Mac backend's `127.0.0.1` is not the phone's loopback. Do not expose the
backend publicly, bypass certificate validation, or enable blanket cleartext
to work around the missing transport. USB device testing is the next platform gate.
