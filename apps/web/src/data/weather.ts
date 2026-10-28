import type { SolarPeriod, WeatherBackground, WeatherCondition } from '../types'

export const WEATHER_BACKGROUND_PATH = '/backgrounds/weather/'

export const weatherManifest: WeatherBackground[] = [
  { id: 'morning-sunny', file: '01_morning_sunny.jpg', solarPeriod: 'morning', weather: 'sunny' },
  { id: 'morning-fog', file: '02_morning_fog.jpg', solarPeriod: 'morning', weather: 'fog' },
  { id: 'morning-rain', file: '03_morning_rain.jpg', solarPeriod: 'morning', weather: 'rain' },
  { id: 'day-clear', file: '04_day_clear.jpg', solarPeriod: 'day', weather: 'clear' },
  { id: 'day-cloudy', file: '05_day_cloudy.jpg', solarPeriod: 'day', weather: 'cloudy' },
  { id: 'day-rain', file: '06_day_rain.jpg', solarPeriod: 'day', weather: 'rain' },
  { id: 'day-snow', file: '07_day_snow.jpg', solarPeriod: 'day', weather: 'snow' },
  { id: 'evening-sunset', file: '08_evening_sunset.jpg', solarPeriod: 'evening', weather: 'sunset' },
  { id: 'evening-rain', file: '09_evening_rain.jpg', solarPeriod: 'evening', weather: 'rain' },
  { id: 'evening-snow', file: '10_evening_snow.jpg', solarPeriod: 'evening', weather: 'snow' },
  { id: 'night-clear', file: '11_night_clear.jpg', solarPeriod: 'night', weather: 'clear' },
  { id: 'night-rain', file: '12_night_rain.jpg', solarPeriod: 'night', weather: 'rain' },
  { id: 'night-snow', file: '13_night_snow.jpg', solarPeriod: 'night', weather: 'snow' },
]

export function getSolarPeriod(date: Date): SolarPeriod {
  const hour = date.getHours()
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
  return periodEntries.find((entry) => entry.weather === fallbackWeather[period]) ?? periodEntries[0] ?? manifest[0]
}

export function weatherBackgroundUrl(background: WeatherBackground): string {
  return `${WEATHER_BACKGROUND_PATH}${background.file}`
}
