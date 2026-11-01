# Weather-based wallpapers

Task: Phase 3 / Dashboard personal modules. Owner request (2026-11-01): use the
wallpaper images from Downloads and change them with the weather.

The 13 JPGs in `public/backgrounds/weather` already exactly match the supplied
`AELYS_weather_13_backgrounds` folder (SHA-256 checked for every image). This
slice connects them to the existing forecast store. No new provider, backend,
permission, API or migration is introduced. OPEN / PROPOSED decisions stay as-is.

- Launch/sign-in scenery, desktop shell, mobile Home and Weather card share
  `useWallpaper`. Launch keeps its existing reveal/lock animations and scrims.
- Weather mode is the default for the previous default background. Explicitly
  selected older photos/uploads retain manual mode. Appearance offers a Weather
  wallpaper switch; choosing/uploading a photo selects manual mode. Both the
  mode and original manual choice persist in existing local appearance storage.
- Existing Open-Meteo WMO codes map to clear/cloudy/fog/rain/snow. Thunderstorms
  use rain artwork. Morning snow uses the day snow artwork, since the set has no
  morning snow image. Other missing combinations fall back within their period.
- City UTC offset selects morning (05–10), day (10–17), evening (17–21), night.
  A fresh forecast's daylight flag corrects day/night. Clock ticks every minute
  and on window focus, so the scene changes without a page reload.
- A cached forecast remains usable for 24 hours through a network failure; older
  data falls back to time-of-day scenery. With no chosen city, only the device
  clock selects a scene. Weather source consent and coarse coordinates follow
  the existing weather store; this does not request geolocation automatically.
- Assets are bundled/local and remain available offline. No new animation is
  added; existing text scrims and theme/card opacity remain in effect.

Mapping reference: https://open-meteo.com/en/docs#weather_variable_documentation

Verification:
- Asset comparison: 13/13 supplied JPGs match the bundled files.
- Web typecheck, 64 test files / 510 tests and production build passed.
- Regression tests cover WMO codes, city clock/daylight, snow fallback, stale
  weather, live weather changes, time transitions, explicit manual/uploaded
  choices, mode persistence and the Appearance switch.
- Browser checked against the running local backend with the existing account:
  mobile Home and Weather card show the same supplied image. Selected Алматы
  in the existing Weather settings; the live forecast shows Clear / 7°C, and
  both backgrounds resolve to `11_night_clear.jpg`. Automatic mode is enabled
  in Appearance. Screenshot saved locally for review.

Limits: the supplied images are concept/prototype assets (see their source
README), not newly generated full-resolution photographic originals. Packaged
native builds are not validated by this web change.


Launch follow-up (owner requested 2026-11-01):
- `LaunchIntro.tsx` now uses the same wallpaper hook; removed the hardcoded image
  from its CSS. Existing cached/consented weather, manual choices and clock-only
  fallback work before authentication too, without adding location prompts.
- Regression checks: changing weather while entering credentials preserves the
  input element/value, does not replay the intro and keeps the lock scene active.
- Web typecheck, 63 relevant tests across 5 files and production build: PASS.
- Browser: a separate unauthenticated tab shows `11_night_clear.jpg` behind the
  entry form, matching the existing Алматы setting; screenshot verified. The
  original signed-in tab remains available.


Launch clarity follow-up (owner requested 2026-11-01): removed the 18% scenery
zoom, extra 4% overscan, whole-screen exit scaling and white radial light wash.
Wallpaper reveal/exit now animate opacity only. Logo/card animations and the
local glass treatment behind the sign-in form remain. This avoids additional
resampling/haze; it does not increase detail in the supplied 1080p assets.
Validation: 16 launch/session regression tests and production build passed.
Browser computed scenery styles: filter `none`, transform `none`, inset `0px`;
entry form and selected night image visually verified.


Main-background clarity follow-up (owner requested 2026-11-01): keep the desktop
photo's fade within its lower 64px (48px on module pages), remove the broad canvas
wash and reduce the mobile overlay to a short edge fade. Main wallpaper layers
have no filter or transform. Weather's photo card no longer inherits the glass
backdrop blur; other appearance preferences remain available.
Validation: 28 shell, appearance and wallpaper tests plus production build pass.
Browser confirms main photo filter/transform `none` and Weather backdrop-filter
`none`; selected Алматы forecast and both supplied backgrounds remain visible.
Source image resolution is unchanged.
