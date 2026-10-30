import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WeatherCard, WeatherPill, WeatherSettingsContent } from '../components/Weather'
import { disableWeather, WEATHER_STORAGE_KEY } from '../lib/weather'

let root: ReturnType<typeof createRoot> | undefined
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { localStorage.clear(); disableWeather() })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); localStorage.clear() })
async function mount() {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<><WeatherSettingsContent /><WeatherCard /><WeatherPill /></>))
  return host
}

describe('weather settings and shared displays', () => {
  it('selects a city and updates both displays from one real-contract forecast', async () => {
    const fetchImpl = vi.fn(async (input: URL) => input.hostname.startsWith('geocoding')
      ? json({ results: [{ id: 1, name: 'Алматы', country: 'Казахстан', latitude: 43.25, longitude: 76.9 }] })
      : json({ current: { temperature_2m: 13, apparent_temperature: 12, weather_code: 0, wind_speed_10m: 5, is_day: 1 }, daily: { time: [1793203200], weather_code: [0], temperature_2m_min: [5], temperature_2m_max: [13] } }))
    vi.stubGlobal('fetch', fetchImpl)
    const host = await mount()
    const field = host.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Алматы'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(host.querySelector('[aria-label="Найденные города"]')?.textContent).toContain('Казахстан')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Найденные города"] button')!.click())
    expect(host.querySelector('.weather-current')?.textContent).toContain('13°C')
    expect(host.querySelector('[aria-label="Погода: Алматы, 13°C. Изменить город"]')).not.toBeNull()
    expect(fetchImpl.mock.calls.filter(([url]) => url.hostname === 'api.open-meteo.com')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY)!).location.name).toBe('Алматы')
  })

  it('shows permission denial and offers manual city entry without repeated prompts', async () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, failure: PositionErrorCallback) => failure({ code: 1 } as GeolocationPositionError))
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } })
    const host = await mount()
    expect(getCurrentPosition).not.toHaveBeenCalled()
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Использовать моё местоположение'))!.click())
    expect(host.textContent).toContain('Доступ к местоположению запрещён')
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(false)
    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(WEATHER_STORAGE_KEY)).not.toContain('auto')
  })
})
