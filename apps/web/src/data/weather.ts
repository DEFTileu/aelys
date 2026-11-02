import type { SolarPeriod, WeatherBackground, WeatherCondition } from '../types'

export const WEATHER_BACKGROUND_PATH = '/backgrounds/originals/'

export const weatherManifest: WeatherBackground[] = [
  { id: 'morning-sunny', file: 'golden-sunrise-over-mountain-cityscape.png', solarPeriod: 'morning', weather: 'sunny' },
  { id: 'morning-fog', file: 'misty-alpine-lake-at-sunrise.png', solarPeriod: 'morning', weather: 'fog' },
  { id: 'morning-rain', file: 'rainy-boulevard-beneath-misty-mountains.png', solarPeriod: 'morning', weather: 'rain' },
  { id: 'day-clear', file: 'fountains-beneath-snow-capped-mountains.png', solarPeriod: 'day', weather: 'clear' },
  { id: 'day-cloudy', file: 'alpine-skyline-cityscape.png', solarPeriod: 'day', weather: 'cloudy' },
  { id: 'day-rain', file: 'rainy-boulevard-beneath-snowy-peaks.png', solarPeriod: 'day', weather: 'rain' },
  { id: 'day-snow', file: 'snowy-alpine-ice-arena.png', solarPeriod: 'day', weather: 'snow' },
  { id: 'evening-sunset', file: 'sunset-garden-avenue-with-alpine-peaks.png', solarPeriod: 'evening', weather: 'sunset' },
  { id: 'evening-rain', file: 'rainy-park-path-to-the-ornate-cathedral.png', solarPeriod: 'evening', weather: 'rain' },
  { id: 'evening-snow', file: 'snowy-alpine-ice-arena.png', solarPeriod: 'evening', weather: 'snow' },
  { id: 'night-clear', file: 'glittering-city-beneath-snowy-peaks.png', solarPeriod: 'night', weather: 'clear' },
  { id: 'night-rain', file: 'rainy-boulevard-beneath-misty-mountains.png', solarPeriod: 'night', weather: 'rain' },
  { id: 'night-snow', file: 'blizzard-over-the-alpine-gondola.png', solarPeriod: 'night', weather: 'snow' },
]

export function getSolarPeriod(date: Date, utcOffsetSeconds?: number): SolarPeriod {
  const hour = utcOffsetSeconds === undefined ? date.getHours() : new Date(date.getTime() + utcOffsetSeconds * 1000).getUTCHours()
  if (hour >= 5 && hour < 10) return 'morning'
  if (hour >= 10 && hour < 17) return 'day'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

export function selectWeatherBackground(
  period: SolarPeriod,
  condition: WeatherCondition = 'unknown',
  manifest: WeatherBackground[] = weatherManifest,
): WeatherBackground {
  const periodEntries = manifest.filter((entry) => entry.solarPeriod === period)
  const exact = periodEntries.find((entry) => entry.weather === condition)
  if (exact) return exact
  const fallbackWeather: Record<SolarPeriod, WeatherBackground['weather']> = {
    morning: 'sunny',
    day: 'clear',
    evening: 'sunset',
    night: 'clear',
  }
  // Morning has no snow scene: keep the condition rather than showing sunshine.
  if (condition === 'snow') return manifest.find((entry) => entry.weather === 'snow') ?? periodEntries[0] ?? manifest[0]
  return periodEntries.find((entry) => entry.weather === fallbackWeather[period]) ?? periodEntries[0] ?? manifest[0]
}

export function weatherBackgroundUrl(background: WeatherBackground): string {
  return `${WEATHER_BACKGROUND_PATH}${background.file}`
}

export function currentBackgroundUrl(now: Date = new Date()): string {
  return weatherBackgroundUrl(selectWeatherBackground(getSolarPeriod(now), 'unknown'))
}

/** Open-Meteo WMO codes; unsupported codes never invent a condition. */
export function backgroundCondition(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear'
  if (code === 2 || code === 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 97, 99].includes(code)) return 'rain'
  return 'unknown'
}

export type BackgroundForecast = { code: number; isDay: boolean; fetchedAt: number; utcOffsetSeconds?: number }

export function forecastBackgroundUrl(forecast: BackgroundForecast | null, now: Date = new Date()): string {
  let period = getSolarPeriod(now, forecast?.utcOffsetSeconds)
  const age = forecast ? now.getTime() - forecast.fetchedAt : Infinity
  // Retain the saved weather through short outages, then fall back to the clock.
  const available = age >= 0 && age < 24 * 60 * 60_000
  if (available && age < 30 * 60_000) {
    if (!forecast!.isDay) period = 'night'
    else if (period === 'night') period = 'day'
  }
  const condition = available ? backgroundCondition(forecast!.code) : 'unknown'
  return weatherBackgroundUrl(selectWeatherBackground(period, condition))
}
