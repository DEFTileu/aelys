# Dashboard grid and concise module headers — 2026-10-30

Selected slice: IMPLEMENTATION_PLAN Phase 3 Dashboard/settings, plus the
explicitly requested cleanup of module/Tasks headings. This user clarification
supersedes the older request for always-available direct manipulation recorded
in DASHBOARD_WEATHER_VALIDATION.md. Existing unrelated changes are preserved.

## Current behavior

- Normal Home has no move/resize/remove handles. Layout mutation paths are
  guarded by editing state; ordinary content buttons/checkboxes remain usable.
- Customize (or the existing Widgets navigation entry) enables editing. Done
  removes controls and cancels an active unfinished gesture. Body actions are
  inert during editing to avoid accidentally completing tasks or starting timers.
- The grid uses 112px rows, 16px gaps and column spans, packing tiles into free
  cells. Pointer resize previews and saves only supported sizes:
  Small 1×2 / 240px, Wide 2×2 / 240px, Large 2×4 / 496px,
  Full width 4×2 / 240px. Narrow screens clamp visible columns while preserving
  the stored desktop size. There are no arbitrary saved pixel heights.
- Editing shows a grid, rounded tiles, minus remove controls, corner resize,
  insertion drag, and click/keyboard alternatives for move/size. This follows the
  supplied Control Center reference's layout interaction, without imitating Wi-Fi,
  Bluetooth or other OS actions Aelys cannot actually provide.
- Legacy local layout tuples are normalized to supported shapes without
  dropping existing widget identities/order. Layout save failures are visible.
- Home has a simple Home heading; module headers have only module names, no
  decorative dates or taglines. Tasks has one h1 Tasks and New task, followed by
  its working tabs/filters/list. Date groups remain functional (Today/short dates).
  Photo wallpaper is rendered only on Home.

## Files

- HomeView.tsx: editing guards, normalized sizes, editing-only help/grid state.
- views/desktop/homeLayout.ts: named presets, grid geometry, legacy normalization.
- views/desktop/WidgetFrame.tsx: guarded gestures, preset resize, cancellation,
  editing controls and their non-drag alternatives.
- views/desktop/homeWidgets.tsx: editing-only inert body and shared frame controls.
- styles.css: tile grid, rounded edit controls, responsive Home navigation.
- AppShell.tsx, TasksView.tsx, views/desktop/tasks.css: concise page headings.
- tests/dashboard-layout.test.tsx: new locked/editing semantics and snap tests.

## Validation

- `pnpm --filter @aelys/web typecheck` — passed.
- `pnpm --filter @aelys/web test` — 17 files, 117 tests passed.
- `pnpm --filter @aelys/web build` — passed, 66 modules.
- `git diff --check` — passed.
- Browser QA used an isolated database and localhost:5174, distinct hostname
  from the owner's 127.0.0.1:5173 cookie. Main credentials/data were untouched.
- Browser verified: no edit handles before Customize; preset Small/Wide/Large;
  button and keyboard reordering; actual mouse drag and corner resize; Done;
  reload preserving order and 240/496px sizes with zero editing handles.
- Browser inspected the actual Tasks and Home at 390px and desktop at 1440px.
  Header dates/taglines are absent, Tasks has a single functional title, and
  Home remains the only page with photo layers. Temporary viewport reset.

Browser artifacts: `/tmp/aelys-widget-grid.png`, `/tmp/aelys-tasks-clean.png`.
No backend change/migration, external integration, APK build or macOS build was
part of this UI slice. Those are proposed in the separate goal prompt
[OPTIMIZE_ALL_PLATFORMS.md](goals/OPTIMIZE_ALL_PLATFORMS.md); it has not been launched.
No staging/commit was performed in this mixed working tree.
