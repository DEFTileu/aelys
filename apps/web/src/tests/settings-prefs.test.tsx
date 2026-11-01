import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDesktopState, setSettings } from '../lib/desktopStore'
import { formatTemperature, formatWind, getPrefs, setPrefs } from '../lib/prefs'
import { AppearancePanel } from '../views/settings/AppearancePanel'
import { ProfilePanel } from '../views/settings/panels'
import { WeatherPanel } from '../views/settings/WeatherPanel'
import { getThemePreference } from '../lib/theme'
import { WEATHER_STORAGE_KEY } from '../lib/weather'

// The weather store persists the chosen place; read it back from storage.
const storedLocation = (): { name: string } | undefined => JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY) || 'null')?.location

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(node)) }
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!

beforeEach(() => { localStorage.clear(); setPrefs({ name: '', greeting: 'time', glass: true, reduceMotion: false, units: 'c' }); setSettings({ accent: 0 }) })
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks() })

describe('display preferences', () => {
  it('converts the weather readouts and persists the choice with its document effect', () => {
    expect(formatTemperature(20, 'c')).toBe('20°C'); expect(formatTemperature(20, 'f')).toBe('68°F')
    expect(formatWind(36, 'c')).toBe('10 m/s'); expect(formatWind(16.09, 'f')).toBe('10 mph')
    setPrefs({ reduceMotion: true })
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
    expect(JSON.parse(localStorage.getItem('aelys.prefs.v1')!)).toMatchObject({ reduceMotion: true, units: 'c' })
    expect(getPrefs().reduceMotion).toBe(true)
  })
})

describe('profile panel', () => {
  it('shows the owner and stores the chosen name and greeting', async () => {
    await mount(<ProfilePanel owner={{ name: 'Tile Uzhan', email: 'tile.uzhan@example.com' }} />)
    expect(host.textContent).toContain('tile.uzhan@example.com')
    expect(byLabel('Name').getAttribute('placeholder')).toBe('Tile Uzhan')
    const name = byLabel('Name') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Tile'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(getPrefs().name).toBe('Tile')
    const greeting = byLabel('Greeting') as HTMLSelectElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(greeting, 'hello'); greeting.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(getPrefs().greeting).toBe('hello')
    expect(host.textContent).toContain('“Hello, Tile Uzhan” on Home')
  })
})

describe('appearance panel', () => {
  it('drives the theme, accent, glass and reduce motion settings the app reads', async () => {
    await mount(<AppearancePanel />)
    const radio = (label: string) => [...host.querySelectorAll<HTMLElement>('[role=radio]')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label)!
    await act(async () => radio('Dark').click()); expect(getThemePreference()).toBe('dark')
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true')
    await act(async () => radio('Coral').click()); expect(getDesktopState().accent).toBe(3)
    await act(async () => byLabel('Glass cards').click()); expect(getPrefs().glass).toBe(false)
    await act(async () => byLabel('Reduce motion').click()); expect(document.documentElement.dataset.reduceMotion).toBe('true')
    expect(host.textContent).not.toContain('Celebrations')
  })
})

describe('weather panel', () => {
  it('switches units, searches cities after a pause and selects one', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('geocoding')) return new Response(JSON.stringify({ results: [{ id: 1, name: 'Astana', admin1: 'Akmola', country: 'Kazakhstan', latitude: 51.18, longitude: 71.45 }] }))
      return new Response(JSON.stringify({ current: { temperature_2m: 1, apparent_temperature: 0, weather_code: 0, wind_speed_10m: 2, is_day: 1 }, daily: { time: [1793203200], weather_code: [0], temperature_2m_min: [0], temperature_2m_max: [2] }, utc_offset_seconds: 0 }))
    })
    await mount(<WeatherPanel />)
    await act(async () => [...host.querySelectorAll<HTMLElement>('[role=radio]')].find((item) => item.textContent === '°F · mph')!.click())
    expect(getPrefs().units).toBe('f')
    const input = byLabel('Search city') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Astana'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    const option = host.querySelector<HTMLElement>('[role=option]')!
    expect(option.textContent).toContain('Astana · Akmola, Kazakhstan')
    await act(async () => option.click())
    expect(storedLocation()?.name).toBe('Astana')
  })
})
