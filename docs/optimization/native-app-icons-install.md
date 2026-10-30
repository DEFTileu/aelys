# Native icon installation — 2026-10-30

Owner-authorized follow-up to the ACTUAL design integration. Selected task:
Implementation Plan Phase 8, Mac/Android installers and clean onboarding.
No architecture decision or native transport/session permission changed.

## Changes

The existing Aelys mark now produces the real application icons, rather than
only appearing inside the web UI. Tracked SVG inputs and a regeneration script
produce macOS ICNS/PNG, Android fallback images, adaptive foreground/background
and monochrome variants. Both Tauri configurations select the packaged icons.
The Android preparation hook restores these resources after project generation.

## Installation and verification

- `node scripts/generate-app-icons.mjs`: passed; both platform icon sets produced.
- `pnpm --filter @aelys/mobile test`: **5 passed**, including resource restoration,
  preservation of unrelated file-provider resources and missing-source denial.
- `pnpm --filter @aelys/mobile tauri:android:build --apk --target aarch64 --ci`:
  passed, including the production frontend build and strict cleartext policy.
- Android release aligned with SDK `zipalign -P 16`, signed with the existing
  local Android Debug certificate. Certificate SHA-256 matched the installed
  package before `adb install -r --no-streaming`; installation returned Success.
  This is a local test signature, not a production signing identity.
- Samsung SM-S721B / arm64: package remained `com.aelys.mobile`; first-install
  timestamp remained unchanged. App update completed without uninstalling,
  resetting or clearing application data. MainActivity resumed, the process was
  alive, and the app-specific fatal log check was empty.
- Android Settings displayed the new Aelys icon. App startup displayed the new
  design and the existing HTTPS server-unavailable state. This proves install,
  launch and icon integration; it does not prove authenticated module access.
- macOS app built with local ad-hoc identity `-`, without changing the checked-in
  release signing policy. Installed at `~/Applications/Aelys.app` and registered
  with Launch Services. `codesign --verify --deep --strict` passed before and
  after copying. The installed ICNS bytes match the tracked icon.
- Installed Mac app opened the new entry screen with explicit Touch ID. No
  password, biometric confirmation or Keychain authorization was supplied by the
  agent. User auth data and backend database were preserved.
- `git diff --check`: passed.

Current local APK: `output/android/aelys-arm64-actual-icons-local-signed.apk`
(33885376 bytes), SHA-256
`5a898615e38e06dacacfec13517f5d86fef6fb4e1202af96e70d5b6e3b7f46d8`.

Installed macOS executable SHA-256:
`ed4b8f3252f51b5335656168776d260b2f40806023ff367cc1b2547c7dcbbc2e`.

Screenshots are kept locally in ignored `output/android/actual-launcher-icon.png`,
`output/android/actual-icons-installed.png` and `output/native-icons/mac-installed.png`.
No signing keys, user databases or build artifacts are committed.

## Remaining gates

The phone still needs an owner-configured, reachable HTTPS backend. No public
exposure, certificate bypass or cleartext allowance was introduced. Mac signing
is local ad-hoc; notarization and production Android signing remain separate
release gates. A complete module/device security acceptance is not claimed.
