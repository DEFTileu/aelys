import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundCondition, forecastBackgroundUrl } from '../data/weather'
import { useWallpaper } from '../lib/wallpaper'
import { getDesktopState, setSettings } from '../lib/desktopStore'
import { AppearancePanel } from '../views/settings/AppearancePanel'

const weather = vi.hoisted(() => ({ forecast: null as null | { code: number; fetchedAt: number; isDay: boolean; utcOffsetSeconds: number } }))
vi.mock('../lib/weather', () => ({ useWeather: () => weather }))
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T07:00:00Z'))
  weather.forecast = null; localStorage.clear()
  setSettings({ wallpaper: 0, wallpaperMode: 'weather', customWallpaper: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks() })

const forecast = (code: number, isDay = true) => ({ code, isDay, fetchedAt: Date.now(), utcOffsetSeconds: 18000 })
function Wallpaper() { return <div data-testid="wallpaper">{useWallpaper()}</div> }

describe('automatic weather wallpapers', () => {
  it.each([[0, 'clear'], [1, 'clear'], [2, 'cloudy'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'], [51, 'rain'], [67, 'rain'], [82, 'rain'], [95, 'rain'], [99, 'rain'], [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'], [-1, 'unknown'], [NaN, 'unknown'], [4, 'unknown']])('maps WMO %s to %s', (code, condition) => { expect(backgroundCondition(Number(code))).toBe(condition) })

  it('uses city time and daylight, keeps snow in the morning and ignores old forecasts', () => {
    expect(forecastBackgroundUrl(forecast(61))).toContain('rainy-boulevard-beneath-snowy-peaks.png')
    expect(forecastBackgroundUrl(forecast(73, false))).toContain('blizzard-over-the-alpine-gondola.png')
    expect(forecastBackgroundUrl(forecast(3))).toContain('alpine-skyline-cityscape.png')
    const morning = new Date('2026-11-01T02:00:00Z')
    expect(forecastBackgroundUrl({ ...forecast(73), fetchedAt: morning.getTime() }, morning)).toContain('snowy-alpine-ice-arena.png')
    expect(forecastBackgroundUrl({ ...forecast(61), fetchedAt: Date.now() - 2 * 86_400_000 })).toContain('fountains-beneath-snow-capped-mountains.png')
  })

  it('updates on weather changes, clock transitions and returning from sleep', async () => {
    weather.forecast = forecast(61)
    await act(async () => root!.render(<Wallpaper />))
    expect(host.textContent).toBe('/wallpapers/rain.jpg')
    weather.forecast = forecast(73, false)
    await act(async () => root!.render(<Wallpaper />))
    expect(host.textContent).toBe('/wallpapers/night.jpg')
    weather.forecast = null
    vi.setSystemTime(new Date(2026, 10, 1, 16, 59, 30))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(host.textContent).toContain('fountains-beneath-snow-capped-mountains.png')
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(host.textContent).toContain('sunset-garden-avenue-with-alpine-peaks.png')
  })

  it('preserves uploaded/manual choices and allows enabling automatic mode again', async () => {
    setSettings({ wallpaper: -1, customWallpaper: 'data:image/png;base64,example' })
    await act(async () => root!.render(<Wallpaper />))
    expect(host.textContent).toBe('data:image/png;base64,example')
    await act(async () => setSettings({ wallpaperMode: 'weather' }))
    expect(host.textContent).toContain('/backgrounds/originals/')
    expect(JSON.parse(localStorage.getItem('aelys.desktop.state.v1')!)).toMatchObject({ wallpaperMode: 'weather', customWallpaper: 'data:image/png;base64,example' })
  })

  it('exposes the automatic mode in Appearance and selecting a photo disables it', async () => {
    await act(async () => root!.render(<AppearancePanel />))
    const automatic = [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find(button => button.getAttribute('aria-label') === 'Weather wallpaper')!
    expect(automatic.getAttribute('aria-checked')).toBe('true')
    const photo = host.querySelector<HTMLButtonElement>('button[aria-label="Wallpaper 2"]')!
    await act(async () => photo.click())
    expect(getDesktopState().wallpaperMode).toBe('manual')
    await act(async () => automatic.click())
    expect(getDesktopState().wallpaperMode).toBe('weather')
  })
})
