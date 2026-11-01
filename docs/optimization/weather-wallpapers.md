# Weather-based wallpapers

Task: Phase 3 / Dashboard personal modules. Owner request (2026-11-01): use the
wallpaper images from Downloads and change them with the weather.

The 13 JPGs in `public/backgrounds/weather` already exactly match the supplied
`AELYS_weather_13_backgrounds` folder (SHA-256 checked for every image). This
slice connects them to the existing forecast store. No new provider, backend,
permission, API or migration is introduced. OPEN / PROPOSED decisions stay as-is.

- Desktop shell, mobile Home and Weather card share `useWallpaper`.
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
