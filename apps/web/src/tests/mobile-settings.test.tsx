import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../views/SettingsView'

const mocks = vi.hoisted(() => ({ telegram: vi.fn() }))
vi.mock('../lib/api', () => ({
  getApiConfig: () => ({ baseUrl: '/api/v1' }), saveApiBaseUrl: vi.fn(), logout: vi.fn(),
  getSharedApiClient: () => ({ me: async () => ({ email: 'tile.uzhan@example.com' }), telegramStatus: mocks.telegram, updateTelegramSettings: vi.fn() }),
}))
vi.mock('../lib/nativeTransport', () => ({ isNativeHost: () => false, isKeychainAccessRequired: () => false, KEYCHAIN_ACCESS_NOTICE: 'Keychain' }))
vi.mock('../views/ProviderSettings', () => ({ ProviderSettings: () => <div>Provider controls</div> }))
vi.mock('../views/TelegramSettings', () => ({ TelegramSettings: () => <div>Telegram controls</div> }))
vi.mock('../views/MemorySettings', () => ({ MemorySettings: () => <div>Memory controls</div> }))
vi.mock('../views/GoogleCalendarSettings', () => ({ GoogleCalendarSettings: () => <div>Calendar controls</div> }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<SettingsView apiStatus="ready" theme="light" onToggleTheme={() => {}} />)) }
const back = () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to settings"]')

beforeEach(() => {
  // Phone width: the mobile switch must pick the one-screen-at-a-time layout.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', addEventListener() {}, removeEventListener() {} }))
  mocks.telegram.mockResolvedValue({ configured: false })
  window.history.replaceState({}, '', '/settings')
})
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('mobile settings', () => {
  it('shows only the grouped list first, with no desktop sidebar', async () => {
    await mount()
    expect(host.querySelector('.st.st-m')).not.toBeNull()
    expect(host.querySelector('aside.st-nav')).toBeNull()
    expect([...host.querySelectorAll('.st-nav-group')].map((item) => item.textContent)).toEqual(['Account', 'General', 'Assistant', 'System'])
    expect(host.querySelector('.st-title')).toBeNull()
  })
  it('opens one panel at a time and returns to the list with Back', async () => {
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-section="notifications"]')!.click())
    expect(host.querySelector('.st-title')?.textContent).toBe('Notifications')
    expect(host.querySelector('.st-nav-list')).toBeNull()
    await act(async () => back()!.click())
    expect(host.querySelector('.st-title')).toBeNull()
    expect(host.querySelector('[data-section="security"]')).not.toBeNull()
  })
  it('opens the panel named by the Telegram deep link', async () => {
    window.history.replaceState({}, '', '/settings?section=telegram'); await mount()
    expect(host.textContent).toContain('Telegram controls')
    expect(back()).not.toBeNull()
  })
})
