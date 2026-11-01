import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../components/AppShell'
import { displayNameFromEmail } from '../lib/owner'

const client = vi.hoisted(() => ({ me: vi.fn(), tasks: vi.fn(), mailMessages: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
vi.mock('../components/NotificationCenter', () => ({ NotificationCenter: () => null }))
vi.mock('../components/Weather', () => ({ WeatherSettingsDialog: () => null }))
vi.mock('../components/CommandPalette', () => ({ CommandPalette: () => null }))

describe('displayNameFromEmail', () => {
  it('turns a plain name into a display name and rejects ids and numbers', () => {
    expect(displayNameFromEmail('tileuzhan@example.com')).toBe('Tileuzhan')
    expect(displayNameFromEmail('ada.lovelace@example.com')).toBe('Ada Lovelace')
    expect(displayNameFromEmail('1')).toBeNull()
    expect(displayNameFromEmail('user_42@example.com')).toBeNull()
    expect(displayNameFromEmail('')).toBeNull()
    expect(displayNameFromEmail(null)).toBeNull()
  })
})

describe('shell owner', () => {
  let root: ReturnType<typeof createRoot> | undefined
  const originalWidth = window.innerWidth
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    client.tasks.mockResolvedValue([]); client.mailMessages.mockResolvedValue([])
  })
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); vi.clearAllMocks() })
  async function mount() {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(<AppShell route="/" apiStatus="ready" theme="light" onToggleTheme={() => {}}><div /></AppShell>))
    return host
  }

  it('greets the signed-in owner and shows the owner in the profile block', async () => {
    client.me.mockResolvedValue({ id: 'o', email: 'tileuzhan@example.com', device_id: null })
    const host = await mount()
    expect(host.querySelector('.shell-hero h1')?.textContent).toMatch(/^Good (morning|afternoon|evening), Tileuzhan$/)
    expect(host.querySelector('aside')?.textContent).toContain('tileuzhan@example.com')
  })

  it('falls back to a neutral greeting when the owner has no usable name', async () => {
    client.me.mockResolvedValue({ id: 'o', email: null, device_id: null })
    const host = await mount()
    expect(host.querySelector('.shell-hero h1')?.textContent).toMatch(/, there$/)
    expect(host.querySelector('aside')?.textContent).not.toContain('Tileuzhan')
  })

  it('keeps working when the owner request fails and shows the unread mail count on Mail', async () => {
    client.me.mockRejectedValue(new Error('offline'))
    client.mailMessages.mockResolvedValue([{ id: '1', is_read: false }, { id: '2', is_read: true }, { id: '3', is_read: false }])
    const host = await mount()
    expect(host.querySelector('.shell-hero h1')?.textContent).toMatch(/, there$/)
    expect(host.querySelector('nav[aria-label="Primary"] button[aria-label="Mail"] .shell-nav-badge')?.textContent).toBe('2')
  })
})
