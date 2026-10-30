import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../views/SettingsView'

const mocks = vi.hoisted(() => ({ native: false, save: vi.fn(), logout: vi.fn(), navigate: vi.fn() }))
vi.mock('../lib/api', () => ({ getApiConfig: () => ({ baseUrl: '/api/v1' }), saveApiBaseUrl: mocks.save, logout: mocks.logout }))
vi.mock('../lib/nativeTransport', () => ({ isNativeHost: () => mocks.native, isKeychainAccessRequired: () => false, KEYCHAIN_ACCESS_NOTICE: 'Keychain' }))
vi.mock('../lib/router', () => ({ navigate: mocks.navigate }))
vi.mock('../views/desktop/SettingsScreen', () => ({ SettingsScreen: () => <div>Appearance controls</div> }))
vi.mock('../views/ProviderSettings', () => ({ ProviderSettings: () => <div>Provider controls</div> }))
vi.mock('../views/TelegramSettings', () => ({ TelegramSettings: () => <div>Telegram controls</div> }))
vi.mock('../components/Weather', () => ({ WeatherSettingsContent: () => <div>Weather controls</div> }))
vi.mock('../components/BiometricSettings', () => ({ BiometricSettings: () => <div>Biometric controls</div> }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<SettingsView apiStatus="ready" theme="light" onToggleTheme={() => {}} />)) }
async function click(label: string) { const element = [...host.querySelectorAll('button, a')].find((item) => item.textContent?.includes(label)) as HTMLElement; expect(element).toBeTruthy(); await act(async () => element.click()) }
async function search(value: string) { const input = host.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }

beforeEach(() => { mocks.native = false; vi.clearAllMocks(); window.history.replaceState({}, '', '/settings') })
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

describe('settings navigation', () => {
  it.each([false, true])('opens Appearance by default with native=%s', async (native) => {
    mocks.native = native; await mount()
    expect(host.textContent).toContain('Appearance controls')
    expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Appearance')
    expect(host.textContent?.includes('Безопасность')).toBe(native)
  })
  it('filters section names and descriptions, and navigates real panels', async () => {
    await mount(); await search('models')
    expect(host.querySelector('nav')?.textContent).toContain('AI & models')
    expect(host.querySelector('nav')?.textContent).not.toContain('Connection')
    await click('AI & models'); expect(host.textContent).toContain('Provider controls')
    await search('connection'); await click('Connection'); expect(host.textContent).toContain('API connection')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(mocks.save).toHaveBeenCalledWith('/api/v1')
    mocks.logout.mockResolvedValue(undefined); await click('Sign out'); expect(mocks.logout).toHaveBeenCalled()
    await search('no such section'); expect(host.textContent).toContain('No settings sections found.')
    await search('components'); await click('Компоненты'); expect(mocks.navigate).toHaveBeenCalledWith('/components')
  })
  it('retains the Telegram deep link and native security panel', async () => {
    mocks.native = true; window.history.replaceState({}, '', '/settings?section=telegram'); await mount()
    expect(host.textContent).toContain('Telegram controls')
    await click('Безопасность'); expect(host.textContent).toContain('Biometric controls')
    await click('Погода и город'); expect(host.textContent).toContain('Weather controls')
  })
})
