import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const forecastBody = { utc_offset_seconds: 18000, current: { temperature_2m: 12.4, apparent_temperature: 11.1, weather_code: 3, wind_speed_10m: 6.2, is_day: 1 }, daily: { time: [1793203200, 1793289600, 1793376000], weather_code: [3, 2, 61], temperature_2m_min: [5, 6, 7], temperature_2m_max: [12, 13, 14] } }
const city = { id: 1526384, name: 'Алматы', region: 'Казахстан', latitude: 43.3, longitude: 76.9, mode: 'city' as const }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
beforeEach(() => { localStorage.clear(); vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

describe('weather source and consent', () => {
  it('does not ask for location or fetch a provider until the user selects a source', async () => {
    const getCurrentPosition = vi.fn()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    const fetchImpl = vi.fn(); vi.stubGlobal('fetch', fetchImpl)
    const weather = await import('../lib/weather')
    await weather.refreshWeather(); await weather.resumeAutomaticWeatherLocation()
    expect(fetchImpl).not.toHaveBeenCalled(); expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('searches the real geocoding contract and separates same-name cities by region', async () => {
    const fetchImpl = vi.fn(async (_url: URL) => json({ results: [{ id: 1, name: 'Алматы', latitude: 43.25667, longitude: 76.92861, admin1: 'Алматы', country: 'Казахстан' }, { id: 2, name: 'Алматы', latitude: 45, longitude: 77, country: 'Казахстан' }, { id: 3, name: 'broken', latitude: 'nope', longitude: 77 }] }))
    vi.stubGlobal('fetch', fetchImpl)
    const weather = await import('../lib/weather')
    expect(await weather.searchCities('А')).toEqual([])
    const cities = await weather.searchCities(' Алматы ')
    expect(cities).toHaveLength(2)
    expect(cities[0]).toMatchObject({ latitude: 43.3, longitude: 76.9, region: 'Алматы, Казахстан' })
    const url = fetchImpl.mock.calls[0]![0] as unknown as URL
    expect(url.origin).toBe('https://geocoding-api.open-meteo.com')
    expect(url.searchParams.get('name')).toBe('Алматы')
  })

  it('stores only coarse coordinates and shares a forecast request across consumers', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 43.2566723, longitude: 76.9286135 } } as GeolocationPosition))
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    const fetchImpl = vi.fn(async (_url: URL, _options?: RequestInit) => json(forecastBody)); vi.stubGlobal('fetch', fetchImpl)
    const weather = await import('../lib/weather')
    await weather.detectWeatherLocation()
    const stored = localStorage.getItem(weather.WEATHER_STORAGE_KEY)!
    expect(stored).not.toContain('43.2566723'); expect(stored).not.toContain('76.9286135')
    expect(JSON.parse(stored).location).toEqual({ name: 'Текущее местоположение', latitude: 43.3, longitude: 76.9, mode: 'auto' })
    const url = fetchImpl.mock.calls[0]![0]
    expect(url.searchParams.get('latitude')).toBe('43.3'); expect(url.searchParams.get('longitude')).toBe('76.9')
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    await Promise.all([weather.refreshWeather(), weather.refreshWeather()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await Promise.all([weather.refreshWeather(true), weather.refreshWeather(true)])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('resumes automatic location only with prior consent and granted permission', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 43.25, longitude: 76.92 } } as GeolocationPosition))
    const query = vi.fn(async () => ({ state: 'granted' as PermissionState }))
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition }, permissions: { query } })
    vi.stubGlobal('fetch', vi.fn(async () => json(forecastBody)))
    const weather = await import('../lib/weather')
    await weather.resumeAutomaticWeatherLocation(); expect(query).not.toHaveBeenCalled()
    await weather.detectWeatherLocation(); expect(getCurrentPosition).toHaveBeenCalledTimes(1)
    await weather.resumeAutomaticWeatherLocation(); expect(getCurrentPosition).toHaveBeenCalledTimes(2)
    query.mockResolvedValue({ state: 'denied' })
    await weather.resumeAutomaticWeatherLocation(); expect(getCurrentPosition).toHaveBeenCalledTimes(2)
    query.mockResolvedValue({ state: 'prompt' })
    await weather.resumeAutomaticWeatherLocation(); expect(getCurrentPosition).toHaveBeenCalledTimes(2)
    weather.selectWeatherCity(city); await settled()
    await weather.resumeAutomaticWeatherLocation(); expect(getCurrentPosition).toHaveBeenCalledTimes(2)
  })

  it('handles denied permission without replacing an existing manual city', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(forecastBody)))
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => failure({ code: 1 } as GeolocationPositionError) } })
    const weather = await import('../lib/weather')
    weather.selectWeatherCity(city); await settled(); await weather.detectWeatherLocation()
    expect(JSON.parse(localStorage.getItem(weather.WEATHER_STORAGE_KEY)!).location.mode).toBe('city')
  })

  it('retains the cached forecast offline and restores it after module reload', async () => {
    const fetchImpl = vi.fn(async () => json(forecastBody)); vi.stubGlobal('fetch', fetchImpl)
    const weather = await import('../lib/weather')
    weather.selectWeatherCity(city); await settled()
    const cached = JSON.parse(localStorage.getItem(weather.WEATHER_STORAGE_KEY)!).forecast
    expect(cached.temperature).toBe(12.4)
    fetchImpl.mockRejectedValue(new TypeError('Offline'))
    await weather.refreshWeather(true)
    expect(JSON.parse(localStorage.getItem(weather.WEATHER_STORAGE_KEY)!).forecast).toEqual(cached)
    vi.resetModules(); const reloaded = await import('../lib/weather')
    await reloaded.refreshWeather(); expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('ignores an in-flight response after weather is disabled', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const weather = await import('../lib/weather')
    weather.selectWeatherCity(city); weather.disableWeather(); finish(json(forecastBody)); await settled()
    expect(JSON.parse(localStorage.getItem(weather.WEATHER_STORAGE_KEY)!)).toEqual({ location: null, forecast: null })
  })

  it('rejects incomplete provider data instead of inventing values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ current: { temperature_2m: null } })))
    const weather = await import('../lib/weather')
    await expect(weather.fetchForecast(city)).rejects.toThrow('неполные данные')
  })
})
