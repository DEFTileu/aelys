import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../views/SettingsView'

const mocks = vi.hoisted(() => ({ native: false, save: vi.fn(), logout: vi.fn(), telegram: vi.fn(), update: vi.fn() }))
vi.mock('../lib/api', () => ({
  getApiConfig: () => ({ baseUrl: '/api/v1' }), saveApiBaseUrl: mocks.save, logout: mocks.logout,
  getSharedApiClient: () => ({ me: async () => ({ email: 'tile.uzhan@example.com' }), telegramStatus: mocks.telegram, updateTelegramSettings: mocks.update }),
}))
vi.mock('../lib/nativeTransport', () => ({ isNativeHost: () => mocks.native, isKeychainAccessRequired: () => false, KEYCHAIN_ACCESS_NOTICE: 'Keychain' }))
vi.mock('../views/ProviderSettings', () => ({ ProviderSettings: () => <div>Provider controls</div> }))
vi.mock('../views/TelegramSettings', () => ({ TelegramSettings: () => <div>Telegram controls</div> }))
vi.mock('../components/BiometricSettings', () => ({ BiometricSettings: () => <div>Biometric controls</div> }))
vi.mock('../views/MemorySettings', () => ({ MemorySettings: () => <div>Memory controls</div> }))
vi.mock('../views/GoogleCalendarSettings', () => ({ GoogleCalendarSettings: () => <div>Calendar controls</div> }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<SettingsView apiStatus="ready" theme="light" onToggleTheme={() => {}} />)) }
const navItem = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('.st-nav-item')].find((item) => item.textContent?.startsWith(title))!
async function click(title: string) { const element = navItem(title); expect(element).toBeTruthy(); await act(async () => element.click()) }
async function search(value: string) { const input = host.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }

beforeEach(() => { mocks.native = false; vi.clearAllMocks(); localStorage.clear(); mocks.telegram.mockResolvedValue({ configured: false }); window.history.replaceState({}, '', '/settings') })
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

describe('settings navigation', () => {
  it('groups the sections as in the design and opens Profile with the real owner', async () => {
    await mount()
    expect([...host.querySelectorAll('.st-nav-group')].map((item) => item.textContent)).toEqual(['Account', 'General', 'Assistant', 'System'])
    expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Profile')
    expect(host.querySelector('.st-title')?.textContent).toBe('Profile')
    expect(host.textContent).toContain('tile.uzhan@example.com')
    expect(host.textContent).toContain('Tile Uzhan')
  })
  it.each([false, true])('shows the Security panel with native=%s', async (native) => {
    mocks.native = native; await mount(); await click('Security')
    expect(host.textContent).toContain(native ? 'Biometric controls' : 'available in the Aelys Mac app')
  })
  it('opens Devices between Connection and Security, with the USB hint where Web Serial is missing', async () => {
    await mount()
    const titles = [...host.querySelectorAll('.st-nav-item')].map((item) => item.querySelector('.st-nav-text > span')?.textContent)
    expect(titles.slice(titles.indexOf('Connection'), titles.indexOf('Security') + 1)).toEqual(['Connection', 'Devices', 'Security'])
    await click('Devices'); expect(host.querySelector('.st-title')?.textContent).toBe('Devices')
    expect(host.textContent).toContain('To add a companion, connect it by USB')
  })
  it('filters section names and descriptions, and navigates real panels', async () => {
    await mount(); await search('models')
    expect(host.querySelector('nav')?.textContent).toContain('AI & models')
    expect(host.querySelector('nav')?.textContent).not.toContain('Security')
    await click('AI & models'); expect(host.textContent).toContain('Provider controls')
    await search('backend address'); await click('Connection'); expect(host.textContent).toContain('API base URL')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(mocks.save).toHaveBeenCalledWith('/api/v1')
    mocks.logout.mockResolvedValue(undefined)
    await act(async () => [...host.querySelectorAll('button')].find((item) => item.textContent === 'Sign out')!.click())
    expect(mocks.logout).toHaveBeenCalled()
    await search('no such section'); expect(host.textContent).toContain('No settings sections found.')
  })
  it('retains the Telegram deep link and the sections the design lacks', async () => {
    window.history.replaceState({}, '', '/settings?section=telegram'); await mount()
    expect(host.textContent).toContain('Telegram controls')
    await click('Weather & location'); expect(host.querySelector('input[aria-label="Search city"]')).not.toBeNull()
    await click('Memory'); expect(host.textContent).toContain('Memory controls')
    await click('Google Calendar'); expect(host.textContent).toContain('Calendar controls')
  })
  it('keeps the list and the panel as separate views on a phone', async () => {
    await mount()
    expect(host.querySelector('.st')?.getAttribute('data-open')).toBe('false')
    await click('Notifications'); expect(host.querySelector('.st')?.getAttribute('data-open')).toBe('true')
    // The shell's back button navigates to the bare settings URL, which the panel follows.
    await act(async () => { window.history.replaceState({}, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(host.querySelector('.st')?.getAttribute('data-open')).toBe('false')
  })
  it('sends Notifications to Telegram until the bot is connected, then edits reminders and quiet hours there', async () => {
    await mount(); await click('Notifications')
    expect(host.textContent).toContain('Connect Telegram')
    await act(async () => [...host.querySelectorAll('button')].find((item) => item.textContent === 'Open Telegram')!.click())
    expect(host.textContent).toContain('Telegram controls')
    const status = { configured: true, version: 2, deadline_reminders: false, quiet_start: null, quiet_end: null }
    mocks.telegram.mockResolvedValue(status); mocks.update.mockResolvedValue({ ...status, version: 3, deadline_reminders: true })
    await click('Notifications')
    await act(async () => host.querySelector<HTMLButtonElement>('[role=switch][aria-label="Deadline reminders"]')!.click())
    expect(mocks.update).toHaveBeenCalledWith({ version: 2, deadline_reminders: true })
    mocks.update.mockResolvedValue({ ...status, version: 4, quiet_start: '22:00', quiet_end: '08:00' })
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((item) => item.textContent === '22:00–08:00')!.click())
    expect(mocks.update).toHaveBeenLastCalledWith({ version: 3, quiet_start: '22:00', quiet_end: '08:00' })
  })
})
