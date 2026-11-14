import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WeatherOnAelys } from '../views/settings/devices/WeatherOnAelys'

const m = vi.hoisted(() => ({ weather: vi.fn(), setWeather: vi.fn(), clearWeather: vi.fn(), searchCities: vi.fn() }))
vi.mock('../lib/companion/api', () => ({ companion: { weather: m.weather, setWeather: m.setWeather, clearWeather: m.clearWeather } }))
vi.mock('../lib/weather', () => ({ searchCities: m.searchCities }))

const OFF = { name: null, lat: null, lon: null, updated: null }
const CITY = { id: 7, name: 'Testville', region: 'Testland', latitude: 55.8, longitude: 37.6, mode: 'city' as const }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const type = (el: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }))
})
async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<WeatherOnAelys />)); await settle()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const f of Object.values(m)) f.mockReset()
  m.weather.mockResolvedValue(OFF)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('Weather on Aelys', () => {
  it('is off until a city is chosen and sends nothing by itself', async () => {
    await mount()
    expect(host.textContent).toContain('Choose a city to show its weather on Aelys')
    expect(button('Turn off')).toBeUndefined()
    expect(m.setWeather).not.toHaveBeenCalled(); expect(m.searchCities).not.toHaveBeenCalled()
  })

  it('searches with the app geocoder and sends the chosen city', async () => {
    m.searchCities.mockResolvedValue([CITY])
    m.setWeather.mockResolvedValue({ name: 'Testville', lat: 55.8, lon: 37.6, updated: null })
    await mount()
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'Test')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle()
    expect(m.searchCities).toHaveBeenCalledWith('Test')
    expect(host.querySelector('[aria-label="Matching cities"]')?.textContent).toContain('Testland')
    await act(async () => button('Use').click()); await settle()
    expect(m.setWeather).toHaveBeenCalledWith({ name: 'Testville', lat: 55.8, lon: 37.6 })
    expect(host.textContent).toContain('Aelys shows the weather here')
    expect(host.querySelector('[aria-label="Matching cities"]')).toBeNull()
  })

  it('shows the saved city and turns weather off', async () => {
    m.weather.mockResolvedValue({ name: 'Testville', lat: 55.8, lon: 37.6, updated: null })
    m.clearWeather.mockResolvedValue(OFF)
    await mount()
    expect(host.textContent).toContain('Testville')
    await act(async () => button('Turn off').click()); await settle()
    expect(m.clearWeather).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Choose a city to show its weather on Aelys')
  })

  it('keeps the page usable when the city is not found or the server fails', async () => {
    m.searchCities.mockResolvedValueOnce([]).mockResolvedValueOnce([CITY])
    m.setWeather.mockRejectedValue(new Error('boom'))
    await mount()
    const submit = () => act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'Nowhere'); await submit(); await settle()
    expect(host.textContent).toContain('City not found')
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'Test'); await submit(); await settle()
    await act(async () => button('Use').click()); await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong')
    expect(host.textContent).not.toContain('boom') // never the raw error
  })
})
