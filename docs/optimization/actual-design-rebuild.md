# ACTUAL design integration — 2026-10-30

## Scope and authority

Owner-requested UI slice under Implementation Plan Phase 8 hardening and
cross-platform regression checks. The owner explicitly approved implementing the
three ACTUAL exports in `Aelys design rebuild English (1).zip`: Desktop, Mobile,
and Launch. Entries named OLD were skipped, not extracted or edited. Existing
worktrees and the unrelated local `CLAUDE.md` change were preserved.

Archive SHA-256:
`575e3b2fdb27b30263470a104fc777db06d6b30be77965c11eb1c7db2ce69080`.

Sources used:

- `ACTUAL Aelys Desktop.dc.html` — shell and connected module layouts.
- `ACTUAL Aelys Mobile.dc.html` — responsive header, app sheet, tile grid,
  composer and list/reader flows; no simulated device frame or status bar.
- `AelysLaunch_ACTUAL.dc.html` — visual intro and glass authentication entry.
- The exported mark, logo and wallpaper are copied byte-for-byte. Reference
  HTML, its demo data, simulated authentication and `support.js` are not shipped.

No OPEN or PROPOSED architecture decision changed. Android remains the Tauri
spike from ADR-006. No new backend endpoints, migrations or dependencies are
required by this presentation slice.

## Connected behavior

- Shared responsive shell keeps the routed editor mounted when crossing 700px,
  preserving drafts and active streams. Mobile navigation uses the real app
  sheet and existing routes. Widgets enters Home Customize explicitly.
- Home keeps a fixed tile grid and persisted preset sizes. Move/resize controls
  are available only in Customize; mobile CSS respects the saved sizes. Module
  pages use the theme canvas. Home and authentication use their approved artwork.
- Tasks retains versioned mutations, filters, keyboard controls and drafts.
- Calendar uses a scrollable week grid, real occurrences and a mobile agenda.
  Independent mini-calendar month navigation and stale-request protection have
  regression coverage. Its side panel follows the selected day.
- Projects and Notes retain real CRUD, project task progress, version/conflict
  handling and draft behavior. Knowledge now has its own searchable reader over
  the notes API and a deep link into the correct Notes editor. It does not
  invent document collections or metadata absent from `NoteOut`.
- AI Chat retains provider configuration, streaming and cancellation. Prompt
  suggestions populate the composer without sending. Context shortcuts navigate
  real modules; no sample assistant responses or fabricated context counts.
- Mail retains local import, folders/list/reader, drafts and Gmail tools. No
  sending permission was added. Finance retains decimal strings, real account,
  transaction, transfer, category and budget handlers. No invented balances.
- Settings uses a single searchable navigation for real panels, including
  native-only security. It defaults to Appearance on both native and web hosts.
- Launch animation is visual only and never authorizes a session. Password,
  owner initialization, explicit Touch ID and Keychain recovery use the existing
  handlers. Android password entry does not advertise macOS Touch ID.
- Notification loading no longer assumes a JavaScript access token, because
  native tokens remain in the native store.

## Typography and assets

Inter Variable is bundled locally so macOS, Android and browser use the same
font without a CDN. Source: Inter v4.1, `rsms/inter` GitHub repository,
`docs/font-files/InterVariable.woff2`. The upstream SIL Open Font License is
included at `apps/web/public/fonts/inter/LICENSE.txt`. No runtime font requests
leave the application origin.

## Verification

- `pnpm --filter @aelys/web test`: **228 passed**, 36 files.
- `pnpm --filter @aelys/web typecheck`: passed.
- `pnpm --filter @aelys/web build`: passed (97 modules, lazy module chunks).
- `pnpm --filter @aelys/mobile test`: **4 passed** (Android packaging policy).
- `git diff --check`: passed.
- UI and proxied backend health: HTTP 200 at `http://127.0.0.1:5173/`.
- Browser QA used a separate SQLite database/backend on 8016 and frontend on
  5176. Real API records were seeded only there. Task creation through the UI
  persisted after a full reload. Desktop module views, light/dark surfaces and
  mobile Home/Calendar/navigation were inspected. Available IAB mobile viewport
  resolved to 458 CSS pixels; this is responsive QA, not device acceptance.
- Screenshots and synthetic QA data remain in ignored `output/design-rebuild/`.
  No personal database, keys, account credentials or production records were
  changed by the QA workflow.

Final native packaging passed, sequentially after the final frontend build:

- Android: `pnpm --filter @aelys/mobile tauri:android:build --apk --target aarch64 --ci`
  with the installed JDK/SDK/NDK from the mobile README. Produced the **unsigned**
  arm64 release APK at
  `apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`.
  Size: 32974956 bytes; ZIP integrity check passed.
  SHA-256: `df2e6150d9fb8bbac81af3acfb83f6186f2e26d18a887960a558900c5267149e`.
- macOS: `pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app`
  with a command-line configuration enabling the app bundle and reusing the
  already-built `apps/web/dist`. Produced
  `apps/desktop/src-tauri/target/release/bundle/macos/Aelys.app`, **27.98 MiB**.
  Executable SHA-256: `faf30f7387ee433293762c3e501d0b9c850f99eed222ea3b64a6ff9c3f484668`.
  The app is unsigned; no existing installation or Keychain permission was
  replaced or approved. Native Rust code did not change in this slice.
- Frontend content-manifest SHA-256:
  `eec49860504d2299fd78f01a0ba574f16d0d23e086d6f9be1e7a77422bd2d468`.

No APK installation or native biometric prompt was performed during this slice.

## Remaining platform gates

A successful build does not replace a real Android device check, release
signing, macOS signing/notarization or live provider acceptance. The existing
Touch ID / Keychain implementation and native transport security rules were
preserved. APK packaging continues to reject blanket cleartext access. Existing
OPEN integration and security gates remain OPEN; this change does not claim
full release readiness for every module.
