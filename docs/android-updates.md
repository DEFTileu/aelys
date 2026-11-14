# Android update releases

The owner approved the Android Installer in-app update approach. This document
covers its release manifest tooling, not publication or proof that the update
flow works on a device. ADR-006 (the final Android wrapper decision) remains
PROPOSED; background sync, notifications, and secure-storage acceptance remain
open. The initial installer-enabled development APK was installed and launched
on the owner's Samsung SM-S721B (Android 16 / API 36) on 2026-11-13. There is no
published update channel yet. No release is published by the generator.

## Channel and trust

The manifest URL is selected **at build time** with
`AELYS_ANDROID_UPDATE_URL`. Its default is
`https://github.com/DEFTileu/aelys/releases/latest/download/android-update.json`.
A custom HTTPS manifest URL can be built in. The APK artifact URL must be HTTPS
and either share the manifest's origin or be a GitHub release in the same
repository. The URL must have no credentials, query string, or fragment and
must end in `.apk`. Verify the deployed channel and redirect behavior against
the app's native update implementation before release.

The manifest declares a SHA-256 digest and size to detect corruption; it is
not an independent signature of the release. Protect the manifest and release
channel. Before opening the installer, a native-only Android verifier checks
the actual APK's package, version, versionCode, and signing identity against the
installed Aelys. Compatible signing-key rotation uses the APK signing history;
apps with multiple signers require the identical signer set. Android performs
its own installation checks too. The verifier accepts only the fixed private
update-cache path and has no frontend commands.

Checks run once when the authenticated workspace opens. The startup notice can
be dismissed; Settings → About retains Check for updates, Update, progress,
and retry. No download or installation permission request happens until Update
is tapped. An offline/failed automatic check does not interrupt the workspace;
a manual check displays its failure. Installer opening is reported without
claiming installation success, and cancellation can be retried.

Native operations serialize access to the selected release. Manifests are
limited to 64 KiB and APKs to 128 MiB. Downloads use private temporary files,
verify exact size/SHA-256, and rename only verified content. The file is verified
again before installation. Requests send no Aelys credentials, cookies or
telemetry. Redirects are limited to five HTTPS hops on the configured origin;
GitHub channels also allow its release-asset delivery hosts. Direct APK URLs on
GitHub must refer to releases in the configured repository.

## Create a release manifest

Start with an **already signed** APK. Ensure the Android SDK build-tools
`apksigner` and `aapt` executables are on `PATH`, or pass their full paths with
`--apksigner` and `--aapt`. From the repository root:

```sh
node apps/mobile/scripts/android-update-manifest.mjs \
  --apk /path/to/already-signed-release.apk \
  --url https://github.com/DEFTileu/aelys/releases/download/v1.2.3/aelys-android-aarch64.apk \
  > android-update.json
```

The command verifies the APK signature with `apksigner verify`, reads identity,
version, and native ABI with `aapt dump badging`, then hashes the existing file.
It requires package `com.aelys.mobile`, a stable `major.minor.patch` versionName,
a positive versionCode, `arm64-v8a` native code, and a nonempty APK of at most
128 MiB. The manifest records `android-aarch64`, exact size and SHA-256. The
command does not download, sign, modify, or upload an APK. It checks signature
validity, not whether the signer is the previously installed app's signer;
that continuity must be checked by the release operator. Keep the input APK
unchanged throughout generation and publication. A shell redirect may create an
empty output file on failure; check the exit status before using it.

Build the first installer-enabled APK and install it once using the normal
Android installation flow. Every later update must use the same existing
signing key and application ID, and both its stable version and versionCode
must increase. Keep the mobile Cargo package version and `tauri.conf.json`
version aligned. The default Android versionCode is `major * 1000000 + minor *
1000 + patch`; an explicit `bundle.android.versionCode` is supported too. Store
and use the existing signing key through the established
secure release process; never put key material or passwords in commands,
manifest files, logs, or repository files. Uploading and publishing require
separate authorization.

The update flow uses the pinned third-party
[`tauri-plugin-android-installer` 0.1.0](https://crates.io/crates/tauri-plugin-android-installer/0.1.0).
Its role is to start the Android system installer UI. Opening that UI is **not**
proof of a successful update: check the installed version after the app starts
again.

## Physical-device acceptance checklist

Use an actual Android arm64 device, a separately authorized test channel, and
signed test builds using the same existing key and app ID. Record device/Android
version, build versions, and results without collecting secrets or personal data.

- [x] Install the initial installer-enabled APK once; open Aelys and confirm its version. Owner device, 2026-11-13: `adb install -r` succeeded, `am start -W` returned `Status: ok`, and package metadata reports version `0.1.0` / code `1000`. No uninstall or data-clear command was used.
- [ ] Publish or serve a newer manifest and APK only with authorization; confirm the update is offered from the configured channel, and choose Update.
- [ ] Confirm Android's installer appears, approve it, restart the app, and independently verify the newer installed version and retained local data.
- [ ] Deny unknown-app installation permission or cancel the system installer; confirm no success is claimed and retry works after permission is granted.
- [ ] Serve a corrupted/truncated APK or a manifest with an incorrect hash/size; confirm it is rejected and the installer never opens.
- [ ] Disconnect the device and attempt an update check; confirm normal offline use remains available and checking can be retried when online.
- [ ] Check an equal or older version and a wrongly signed or wrong-package APK; confirm they are rejected before the system installer is opened.

The remaining checks are manual gates; initial installation/launch, manifest
generation and unit tests do not establish end-to-end update acceptance or a
working published release channel. Existing user-data retention across a future
update has not been independently inspected.

### Android backend configuration correction, 2026-11-13

The first APK build command omitted `VITE_API_BASE_URL`, leaving the shared
web default `/api/v1`; on Android that resolves to the phone's loopback and is
rejected by the native HTTPS policy. Process-launch evidence alone did not
prove workspace connectivity. Phase 8 installer/onboarding follow-up: the
mobile build command now supplies the same existing hosted HTTPS backend as
`scripts/build-mac-app.sh`, with an explicit self-hosted override and fail-closed
validation. No server, CORS, cleartext, or certificate settings were relaxed.

The optimized APK was rebuilt, signed with the existing local development key,
and installed using `adb install -r`. On the SM-S721B, the authenticated Home
screen displayed existing tasks after replacement and again after force-stop
and relaunch. This establishes this device's startup/connectivity recovery,
not full domain/sync/update acceptance. Android script tests: 13 passed;
web typecheck and actual arm64 release build passed. The corrective build wrapper
and two regression tests are in `apps/mobile/scripts/build-android*.mjs`.
