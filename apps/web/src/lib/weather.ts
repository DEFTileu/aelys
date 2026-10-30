import { useEffect, useSyncExternalStore } from 'react'

export type WeatherLocation = { name: string; latitude: number; longitude: number; mode: 'city' | 'auto' }
export type City = WeatherLocation & { id: number; region: string }
export type Forecast = { locationKey: string; fetchedAt: number; temperature: number; apparent: number; code: number; wind: number; isDay: boolean; days: { date: string; code: number; min: number; max: number }[] }
type WeatherState = { location: WeatherLocation | null; forecast: Forecast | null; status: 'empty' | 'loading' | 'ready' | 'error'; notice: string; settingsOpen: boolean; locating: boolean }
export const WEATHER_STORAGE_KEY = 'aelys.weather.v1'
const FRESH_FOR = 30 * 60_000
const listeners = new Set<() => void>()
const flights = new Map<string, Promise<Forecast>>()
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const round = (value: number) => Math.round(value * 10) / 10
export const locationKey = (location: WeatherLocation) => `${location.latitude},${location.longitude}`
function validLocation(value: unknown): value is WeatherLocation {
  if (!value || typeof value !== 'object') return false
  const item = value as WeatherLocation
  return typeof item.name === 'string' && item.name.length <= 180 && finite(item.latitude) && Math.abs(item.latitude) <= 90 && finite(item.longitude) && Math.abs(item.longitude) <= 180 && ['city', 'auto'].includes(item.mode)
}
function validForecast(value: unknown): value is Forecast {
  if (!value || typeof value !== 'object') return false
  const item = value as Forecast
  return typeof item.locationKey === 'string' && finite(item.fetchedAt) && finite(item.temperature) && finite(item.apparent) && finite(item.wind) && finite(item.code) && typeof item.isDay === 'boolean' && Array.isArray(item.days) && item.days.every((day) => typeof day.date === 'string' && finite(day.code) && finite(day.min) && finite(day.max))
}
function readState(): WeatherState {
  const initial: WeatherState = { location: null, forecast: null, status: 'empty', notice: '', settingsOpen: false, locating: false }
  try {
    const stored = JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY) || 'null')
    if (validLocation(stored?.location)) {
      initial.location = { ...stored.location, latitude: round(stored.location.latitude), longitude: round(stored.location.longitude) }
      if (validForecast(stored.forecast) && stored.forecast.locationKey === locationKey(initial.location!)) initial.forecast = stored.forecast
      initial.status = initial.forecast ? 'ready' : 'empty'
    }
  } catch { /* Invalid cached data is never displayed as a forecast. */ }
  return initial
}
let state = readState()
let generation = 0
function update(patch: Partial<WeatherState>, persist = false) {
  state = { ...state, ...patch }
  if (persist) {
    try { localStorage.setItem(WEATHER_STORAGE_KEY, JSON.stringify({ location: state.location, forecast: state.forecast })) }
    catch { state = { ...state, notice: 'Настройки действуют до закрытия вкладки: хранилище браузера недоступно.' } }
  }
  listeners.forEach((listener) => listener())
}
export function openWeatherSettings() { update({ settingsOpen: true }) }
export function closeWeatherSettings() { update({ settingsOpen: false }) }
async function requestJson(url: URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error('Сервис погоды недоступен. Попробуйте позже.')
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('Сервис вернул некорректную погоду.')
  return body as Record<string, unknown>
}
export async function searchCities(query: string, signal?: AbortSignal): Promise<City[]> {
  if (query.trim().length < 2) return []
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.search = new URLSearchParams({ name: query.trim(), count: '6', language: 'ru', format: 'json' }).toString()
  const body = await requestJson(url, signal)
  if (body.results === undefined) return []
  if (!Array.isArray(body.results)) throw new Error('Не удалось прочитать список городов.')
  return body.results.flatMap((result: unknown): City[] => {
    if (!result || typeof result !== 'object') return []
    const item = result as Record<string, unknown>
    if (!finite(item.id) || typeof item.name !== 'string' || !finite(item.latitude) || Math.abs(item.latitude) > 90 || !finite(item.longitude) || Math.abs(item.longitude) > 180) return []
    return [{ id: item.id, name: item.name.slice(0, 180), region: [item.admin1, item.country].filter((part) => typeof part === 'string').join(', '), latitude: round(item.latitude), longitude: round(item.longitude), mode: 'city' }]
  })
}
export async function fetchForecast(location: WeatherLocation): Promise<Forecast> {
  const key = locationKey(location)
  const running = flights.get(key)
  if (running) return running
  const flight = (async () => {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.search = new URLSearchParams({ latitude: String(round(location.latitude)), longitude: String(round(location.longitude)), current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day', daily: 'weather_code,temperature_2m_max,temperature_2m_min', forecast_days: '3', timezone: 'auto', timeformat: 'unixtime', temperature_unit: 'celsius', wind_speed_unit: 'kmh' }).toString()
    const body = await requestJson(url)
    const current = body.current as Record<string, unknown> | undefined
    const daily = body.daily as Record<string, unknown> | undefined
    if (!current || ![current.temperature_2m, current.apparent_temperature, current.weather_code, current.wind_speed_10m, current.is_day].every(finite)) throw new Error('Сервис вернул неполные данные погоды.')
    if (!daily || ![daily.time, daily.weather_code, daily.temperature_2m_min, daily.temperature_2m_max].every(Array.isArray)) throw new Error('Прогноз недоступен.')
    const times = daily.time as unknown[]; const codes = daily.weather_code as unknown[]; const mins = daily.temperature_2m_min as unknown[]; const maxes = daily.temperature_2m_max as unknown[]
    const days = times.slice(0, 3).flatMap((date, index) => finite(date) && finite(codes[index]) && finite(mins[index]) && finite(maxes[index]) ? [{ date: new Date((date + (finite(body.utc_offset_seconds) ? body.utc_offset_seconds : 0)) * 1000).toISOString(), code: codes[index] as number, min: mins[index] as number, max: maxes[index] as number }] : [])
    if (!days.length) throw new Error('Прогноз недоступен.')
    return { locationKey: key, fetchedAt: Date.now(), temperature: current.temperature_2m as number, apparent: current.apparent_temperature as number, code: current.weather_code as number, wind: current.wind_speed_10m as number, isDay: current.is_day === 1, days }
  })().finally(() => { flights.delete(key) })
  flights.set(key, flight)
  return flight
}
export async function refreshWeather(force = false) {
  const location = state.location
  if (!location) return
  if (!force && state.forecast?.locationKey === locationKey(location) && Date.now() - state.forecast.fetchedAt < FRESH_FOR) return
  const run = generation
  update({ status: 'loading', notice: '' })
  try {
    const forecast = await fetchForecast(location)
    if (generation === run) update({ forecast, status: 'ready', notice: '' }, true)
  } catch (error) {
    if (generation === run) update({ status: 'error', notice: error instanceof Error ? error.message : 'Не удалось загрузить погоду.' })
  }
}
export function selectWeatherCity(city: City) {
  generation += 1
  const location: WeatherLocation = { name: city.name, latitude: round(city.latitude), longitude: round(city.longitude), mode: 'city' }
  update({ location, forecast: null, locating: false, notice: '', status: 'empty' }, true)
  void refreshWeather()
}
export function disableWeather() {
  generation += 1
  update({ location: null, forecast: null, status: 'empty', notice: '', locating: false }, true)
}
export async function detectWeatherLocation() {
  if (!navigator.geolocation) { update({ notice: 'Браузер не поддерживает геолокацию. Выберите город вручную.' }); return }
  const run = ++generation
  update({ locating: true, notice: '' })
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 30 * 60_000 }))
    if (run !== generation) return
    if (!finite(position.coords.latitude) || !finite(position.coords.longitude)) throw new Error('Некорректное местоположение.')
    // The precise position never enters storage, backend requests or logs.
    const location: WeatherLocation = { name: 'Текущее местоположение', latitude: round(position.coords.latitude), longitude: round(position.coords.longitude), mode: 'auto' }
    const changed = !state.location || locationKey(state.location) !== locationKey(location)
    update({ location, forecast: changed ? null : state.forecast, locating: false }, true)
    await refreshWeather()
  } catch (error) {
    if (run !== generation) return
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    update({ locating: false, notice: code === 1 ? 'Доступ к местоположению запрещён. Разрешите его в браузере или выберите город вручную.' : 'Не удалось определить местоположение. Выберите город вручную или повторите.' })
  }
}
export async function resumeAutomaticWeatherLocation() {
  // Never show a permission prompt without an explicit click. Only a previously
  // selected automatic mode and an already granted browser permission resume.
  if (state.location?.mode !== 'auto' || state.locating) return
  if (!navigator.permissions) { await refreshWeather(); return }
  try {
    const permission = await navigator.permissions.query({ name: 'geolocation' })
    if (permission.state === 'granted') await detectWeatherLocation()
    else update({ status: 'error', notice: 'Доступ к местоположению не разрешён. Выберите город или разрешите доступ снова.' })
  } catch { /* Manual city mode and the last cached forecast remain usable. */ }
}
let consumers = 0
let stop: (() => void) | undefined
function startWeather() {
  consumers += 1
  if (consumers === 1) {
    const online = () => { if (state.location?.mode === 'auto') void resumeAutomaticWeatherLocation(); else void refreshWeather() }
    online()
    const timer = window.setInterval(online, FRESH_FOR)
    window.addEventListener('online', online); window.addEventListener('focus', online)
    stop = () => { window.clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener('focus', online) }
  }
  return () => { consumers -= 1; if (consumers === 0) stop?.() }
}
export function useWeather() {
  useEffect(startWeather, [])
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state)
}
export function weatherDescription(code: number): string {
  if (code === 0) return 'Ясно'
  if (code <= 3) return 'Облачно'
  if (code <= 48) return 'Туман'
  if (code <= 67) return 'Дождь'
  if (code <= 77) return 'Снег'
  if (code <= 82) return 'Ливень'
  if (code <= 86) return 'Снегопад'
  return 'Гроза'
}
