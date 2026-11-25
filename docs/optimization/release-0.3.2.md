# Android 0.3.2 and macOS DevTools build — 2026-11-25

Owner authorized macOS rebuild with DevTools, mobile release publication and
removal of task-generated caches/artifacts after validation.
Source integration: 689fd463; mobile version bump: 2703066.

## macOS

`scripts/build-mac-app.sh --devtools` succeeded. Signed with the existing Apple
Development identity and installed at `~/Applications/Aelys.app`; `codesign
--verify --deep --strict` passed and the installed app started. Same designated
requirement as the prior app, preserving its signing identity. Microphone usage
text is present. Not notarized. Installed executable SHA-256:
`1ac96c368e5c310b077b11c1f10cf4ff6acc9dbd45dcf8717211a6cf9abd1afb`.

## Android

Release-mode arm64 build via `tauri:android:build --apk --target aarch64 --ci`:
passed; Java 21, SDK 37, NDK 30. Existing compile/deprecation warnings remain.
`pnpm --filter @aelys/mobile test`: 19 passed. Shared typecheck passed.
APK aligned with zipalign, signed and verified with apksigner. Package
`com.aelys.mobile`, version 0.3.2, versionCode 3002 (prior release 3001).
Existing development signer SHA-256 matches published 0.3.1:
`25c0b41afa097937a4e4a46ebd5788c73e1615514bb7767ab991f00056029dee`.
APK SHA-256: `c761ed22b6157a6eb135cb24597678fe9e0ad487f2545ee65821b8e10a96777b`;
size: 70491583 bytes.

Release assets: `aelys-android-aarch64.apk`, `android-update.json` at
https://github.com/DEFTileu/aelys/releases/tag/v0.3.2 . The manifest is generated
from the signed APK, including identity, version, hash and size. No connected
Android device was available; no physical install/microphone/OTA acceptance
is claimed. Existing owner data/signing keys are preserved during cleanup.
