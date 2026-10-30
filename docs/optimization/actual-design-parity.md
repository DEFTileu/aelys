# ACTUAL visual parity work — 2026-10-30

Selected task: Implementation Plan Phase 8, cross-platform UI regression and
native installation consistency. The owner explicitly requested matching the
three ACTUAL designs from the provided archive. OLD is excluded. Previous
Railway/backend changes and the unrelated CLAUDE.md edit are preserved.

Reference sources: ACTUAL Desktop, ACTUAL Mobile, AelysLaunch_ACTUAL under the
ignored reference extraction. No design runtime, demo data, simulated biometric
flow, device frame or fake system status bar is shipped. Functional API
contracts, encrypted native sessions and sandbox/policy boundaries are retained.

Prior owner constraints still apply: wallpaper only on Home and approved launch
entry; short clear headings; no motivational filler; widget gestures only in
Customize; snapped tile grid. Those intentional owner choices override the
reference's decorative date/greeting copy. Variable user data and platform font
rasterization cannot be represented as a verified 100% pixel score. Verification
must state the actual screens, states, viewports and remaining limitations.

## Implemented

- Home uses ACTUAL desktop proportions (four 264px tiles at the wide breakpoint,
  544px large tiles, 16px gaps, 20px corners). Mobile has an independent persisted
  eight-widget layout, compact cards, bottom composer and actionable chips.
  Existing desktop arrangements migrate to supported tile dimensions without
  resetting their order. Move, resize and remove remain exclusive to Customize.
- Ported the authored launch vector paths, staggered stroke/fill animation,
  rays, glow, letter entrance and landscape transition into local assets. The
  real biometric gate remains authoritative. Its fingerprint control invokes
  the native unlock handler; no simulated successful authentication is shipped.
- Tasks: ACTUAL tabs/default Today, inline date/priority/project quick entry,
  compact rows, detail Revert and confirmed version-aware Delete. Advanced
  controls remain available in More. Light/dark contrast and the Tasks title
  were checked after integrating the toolbar changes.
- Calendar: compact date range, day/week/month controls, five-day desktop week
  with an accessible weekend toggle, mobile agenda, and an AI request toolbar.
  Timezone, recurring series and reminders still use the existing real API.
- Projects: card menu, edit/archive/delete, real task progress, task capture and
  toggle inside the detail pane, linked-note navigation. Notes: ACTUAL column
  widths, mobile list/editor transitions, local draft protection, Markdown
  formatting/preview, word count and explicit save. Knowledge uses live notes.
- Mail: ACTUAL mailbox/list/reader proportions and mobile transitions, inline
  reply drafts, real local draft saving and explicit Gmail draft publication.
  No email sending was introduced. Finance: account balances, category donuts,
  budget progress and history use real signed ledger amounts, with four-place
  BigInt arithmetic and separate currencies.
- Settings: mobile list/detail navigation, appearance controls and persistent
  System appearance following OS changes. Healthy API debug labels are removed
  from normal screens; connection failures remain visible.

## Verification

- `pnpm --filter @aelys/web test`: 248 tests across 40 files passed on the final source (final run: 22:31).
- `pnpm --filter @aelys/web typecheck`: passed. Focused checks after the final
  Tasks structure/theme changes: 27 tests passed; Home/layout/breakpoint checks:
  16 tests passed.
- `.venv/bin/pytest backend/tests --ignore=backend/tests/test_postgres_integration.py -q`:
  204 passed, 5 skipped; existing Starlette TestClient deprecation warning.
  The external PostgreSQL acceptance suite was deliberately excluded from this
  local design task. `.venv/bin/ruff check backend/app/domains/api.py backend/tests/test_tasks_ux_contract.py` passed.
- Task versioned deletion has 10 focused backend tests, including a concurrent
  update between preflight and DELETE; OpenAPI security has 2 passing tests.
- Browser QA used the ACTUAL HTML runtime alongside a separate SQLite test
  instance, never the owner's database. Desktop was inspected at 1422 CSS px;
  Home/settings/knowledge and Customize were checked at 391 px. Home, Tasks,
  Calendar, Projects, Notes, Mail, Finance, AI and Settings were also visited at
  320 px: document width equalled viewport width on all nine screens.
- Browser Customize verification: zero resize controls outside edit mode,
  keyboard resize to Large, 364px mobile height, reload preserving that size,
  followed by restoring only the synthetic test instance's default layout.
- Local screenshots and build logs are under ignored
  `output/design-rebuild/parity/`. Home desktop/mobile and Tasks screenshots
  contain synthetic records, no owner data. Temporary viewport overrides reset.

## Acceptance limits

This is not a measured 100% pixel-diff score. The reference's fixed sample
records, made-up balances, unread counts, session counters, weather and AI
answers were not inserted into the application. Actual text, date, empty/error
states and platform text rasterization differ. The earlier owner instructions
about backgrounds and decorative copy remain intentional differences.

Reference-only controls without a matching supported contract (for example
note tags/folder storage, fake attachment controls and fabricated context
figures) are not advertised as completed features. Native package compilation
is not a claim of a new real-device Touch ID/Gmail/BYOK acceptance run. Existing
installed applications are not silently replaced during this design slice.
Signing/notarization and Android background behavior retain their prior status.

The Railway/RDS deployment files, credentials outside the repository and the
unrelated CLAUDE.md edit remain separate. This work did not publish, push,
change OPEN decisions, send external messages or migrate personal data.

## Final artifacts and checkout

- macOS: `pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app`
  passed on the final UI source; bundle is 27.85 MiB at
  `apps/desktop/src-tauri/target/release/bundle/macos/Aelys.app`.
- Android: release arm64 build command from `apps/mobile/README.md` passed on the
  final source; unsigned APK is in the generated universal/release directory.
  The cleartext prohibition and authored launcher icons remain in the build.
- A final full web run passed 248/248; production web compilation and TypeScript
  passed in both native build hooks. Backend suite passed 204 with 5 skips.
- Native UI acceptance was attempted, but computer-use reported the Mac locked.
  No unlock workaround, app termination or replacement of the running installed
  application was performed. Reopening/updating the native build remains an
  owner-present follow-up after unlocking the Mac.
- Backend concurrency contract commit: `5705504`. UI work remains on
  `codex/actual-design-rebuild`; no remote push or merge was performed.

### Native installation follow-up

The owner reported missing animation. Inspection found the running installed
Mac app dated 19:15, while the parity bundle was dated 22:32. The installed
executable matched the earlier icon-installation hash, not the parity build.
The app was on its locked entry screen with no editor draft open. It was quit
normally, backed up under ~/Applications/Aelys-backups, and replaced with the
latest bundle using the same local ad-hoc hardened-runtime signing approach.
Strict deep signature verification passed. Installed and source executable
hashes matched after signing. Launch was observed in the native window (star
intro), followed by the real Touch ID entry screen. No biometric, password or
Keychain approval was supplied by the agent. Launch animation runs once per
app start, not on each route change; reduced-motion preference is respected.
