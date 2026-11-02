import { getSolarPeriod, type BackgroundForecast } from '../data/weather'

export type WallpaperState = 'clear' | 'cloudy' | 'rain' | 'snow' | 'night'

/** Null when the forecast is missing or stale, so the caller keeps the time-of-day photo. */
export function weatherWallpaperUrl(forecast: BackgroundForecast | null, now: Date = new Date()): string | null {
  if (!forecast) return null
  const age = now.getTime() - forecast.fetchedAt
  if (!(age >= 0 && age < 24 * 60 * 60_000)) return null
  const dark = age < 30 * 60_000 ? !forecast.isDay : getSolarPeriod(now, forecast.utcOffsetSeconds) === 'night'
  const { code } = forecast
  let state: WallpaperState
  if (dark) state = 'night'
  else if (code === 2 || code === 3) state = 'cloudy'
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) state = 'snow'
  else if ((code >= 45 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) state = 'rain'
  else state = 'clear'
  return `/wallpapers/${state}.jpg`
}
