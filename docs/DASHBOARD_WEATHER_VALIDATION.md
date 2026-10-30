# Home layout and weather slice — 2026-10-29

**Historical interaction:** the owner changed the layout requirement on
2026-10-30. Move/resize are now available only in Customize, with fixed tile
sizes. Current evidence: [WIDGET_GRID_VALIDATION.md](WIDGET_GRID_VALIDATION.md).
The weather behavior described here remains unchanged.

Selected milestone: `IMPLEMENTATION_PLAN.md`, Phase 3 / personal modules,
Dashboard and settings deliverable. Scope follows the owner's clarification:
move/resize the existing widgets directly without pressing Customize. Creating
new custom widget types is not requested by that clarification.

## Implemented behavior

- Header/grip pointer drag works for mouse, touch and pen using pointer capture,
  a movement threshold, a card preview following the pointer, a highlighted drop
  destination, insertion reorder and cancellation. Nested action buttons do not
  begin a drag. The corner resizes width (grid columns) and height (192–720 px).
- Handles are available before Customize. Keyboard arrow keys provide equivalent
  reorder/resize actions. Customize still adds/removes the built-in widgets.
- Order and dimensions save locally as backward-compatible layout tuples. Invalid
  spans/heights are clamped, duplicate/unknown widgets rejected. Storage failures
  are visible. Responsive columns clamp displayed width without discarding the
  saved desktop dimensions. Local UI preferences are not server-synced.
- City search, explicit automatic-location mode and disable controls are available
  from the weather widget, the top weather pill, and Settings → Погода и город.
  All weather displays share one source, request flight and 30-minute cache.
- Forecast/current conditions come from Open-Meteo, with attribution, validation,
  timeouts, visible provider errors and timestamped offline fallback. No temperature
  is invented if the provider fails. Geolocation denial leaves manual city input
  usable. Automatic resumption checks permission without prompting.
- Rounded coordinates only (0.1°) are stored/sent. No new backend weather route,
  DB migration, SDK, identity change or sync channel is introduced. The security
  header permits same-origin geolocation while keeping camera/microphone denied.

## Files for this slice

- `apps/web/src/views/desktop/WidgetFrame.tsx`: direct pointer/keyboard gestures.
- `apps/web/src/views/desktop/homeLayout.ts`, `homeWidgets.tsx`, `HomeView.tsx`:
  persistence, validated layout, connected forecast and existing card controls.
- `apps/web/src/lib/weather.ts`, `components/Weather.tsx`: city search, consent,
  typed forecast/cache, shared displays, settings and accessible dialog.
- `apps/web/src/components/AppShell.tsx`, `views/SettingsView.tsx`, `styles.css`:
  entry points and styles consistent with the current design.
- `apps/web/src/tests/dashboard-layout.test.tsx`, `weather-source.test.ts`,
  `weather-settings.test.tsx`: gestures, persistence, consent and source scenarios.
- `backend/app/main.py`, `backend/tests/test_openapi_security.py`: same-origin
  geolocation policy and existing security-header regression check.
- `docs/SELF_HOSTING.md`, `SECURITY.md`: usage, storage and provider boundaries.

## Validation

- `pnpm --filter @aelys/web test`: 66 passed.
- `pnpm --filter @aelys/web typecheck`: passed.
- `pnpm --filter @aelys/web build`: passed.
- `PYTHONPATH=backend .venv/bin/pytest -q backend/tests`: 87 passed, 2 skipped
  (PostgreSQL test environment unavailable), one existing Starlette warning.
- `PYTHONPATH=backend .venv/bin/ruff check --select E9,F backend/app backend/tests`:
  passed.
- `git diff --check`: passed.

Browser evidence: on the actual localhost Home screen, dragged Today from first
to second position without entering Customize, resized it from one to two columns
and from 264 to 312 px, reloaded and confirmed those dimensions persisted.
The revised drag preview was also verified, then the layout was restored. Live
Open-Meteo city search found Алматы, Казахстан; selecting it fetched actual
current conditions and a three-day forecast in both displays. The temporary city selection was disabled after verification, leaving the
location choice to the owner. Actual OS location permission
was not granted by the agent. Granted, denied, pending and missing permission
paths are covered in automated tests. Native touch hardware remains untested.

## Assumptions and limits

Preferences intentionally remain on this browser, consistent with current desktop
appearance settings. Cross-device layout/weather preference sync is future work;
no OPEN/PROPOSED architecture decision is changed. The free weather endpoint is
used for this noncommercial personal app; production commercial hosting needs a
provider/terms decision. Geolocation depends on the browser's secure-context and
OS permissions. Offline forecasts show the last fetch date and cannot refresh
without connectivity. Existing unrelated dirty work was preserved; no staging or
commit was performed.
