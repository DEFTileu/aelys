import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'

const client = vi.hoisted(() => ({ focusOverview: vi.fn(), focusRequests: vi.fn(), saveFocusConfig: vi.fn(), focusUnlock: vi.fn() }))
const guard = vi.hoisted(() => ({ status: vi.fn(), openSettings: vi.fn(), setState: vi.fn(), usage: vi.fn(), applyGrant: vi.fn(), installedApps: vi.fn(), takePendingUnlock: vi.fn() }))
const android = vi.hoisted(() => ({ value: true }))
vi.mock('../lib/api', () => ({ checkApi: vi.fn().mockRejectedValue(new Error('no server')), getApiConfig: () => ({ baseUrl: 'invalid' }), getSharedApiClient: () => client }))
vi.mock('../lib/notificationLog', () => ({ isAndroidHost: () => android.value }))
vi.mock('../lib/focusGuard', async (original) => ({ ...(await original<typeof import('../lib/focusGuard')>()), focusGuard: guard, syncGuard: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../components/AuthGate', () => ({ AuthGate: ({ children }: { children: ReactNode }) => children }))
vi.mock('../components/AppShell', () => ({ AppShell: ({ children, route }: { children: ReactNode; route: string }) => <div><span>Shell: {route}</span>{children}</div> }))
vi.mock('../views/AppsView', () => ({ AppsView: () => <div>Apps</div> }))
vi.mock('../views/FocusView', () => ({ FocusView: () => <div>Limits screen</div> }))
vi.mock('../components/AndroidUpdateNotice', () => ({ AndroidUpdateNotice: () => null }))

const KEY = 'aelys.appLimits.configured'
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
const mount = async () => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<App />)) }
const banner = () => host.querySelector('aside[aria-label="App limits protection"]')
const foreground = () => act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

describe('app-wide protection banner', () => {
  beforeEach(() => {
    vi.clearAllMocks(); android.value = true
    localStorage.setItem(KEY, '1')
    history.replaceState({}, '', '/apps')
    guard.status.mockResolvedValue({ usageAccess: true, accessibility: true }); guard.takePendingUnlock.mockResolvedValue(null)
  })
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; localStorage.removeItem(KEY); history.replaceState({}, '', '/') })

  it('shows when accessibility is off and links to the app limits screen', async () => {
    guard.status.mockResolvedValue({ usageAccess: true, accessibility: false })
    await mount()
    expect(banner()?.textContent).toContain('Protection is off')
    await act(async () => button('Open App limits')!.click())
    expect(window.location.pathname).toBe('/app-limits')
    expect(banner()).toBeNull() // the screen shows its own banner
  })

  it('shows when usage access is off', async () => {
    guard.status.mockResolvedValue({ usageAccess: false, accessibility: true })
    await mount()
    expect(banner()?.textContent).toContain('Protection is off')
  })

  it('shows when the status cannot be read', async () => {
    guard.status.mockRejectedValue(new Error('plugin gone'))
    await mount()
    expect(banner()?.textContent).toContain('cannot confirm that limits are working')
  })

  it('is not shown when everything is on, and appears after a foreground once a permission is lost', async () => {
    await mount()
    expect(guard.status).toHaveBeenCalled()
    expect(banner()).toBeNull()
    guard.status.mockResolvedValue({ usageAccess: true, accessibility: false })
    await foreground()
    expect(banner()).not.toBeNull()
  })

  it('dismissal lasts only until the next foreground', async () => {
    guard.status.mockResolvedValue({ usageAccess: true, accessibility: false })
    await mount()
    await act(async () => button('Dismiss')!.click())
    expect(banner()).toBeNull()
    await foreground()
    expect(banner()).not.toBeNull()
  })

  it('is not shown when limits were never configured', async () => {
    localStorage.removeItem(KEY)
    guard.status.mockResolvedValue({ usageAccess: false, accessibility: false })
    await mount()
    await foreground()
    expect(banner()).toBeNull()
    expect(guard.status).not.toHaveBeenCalled()
  })

  it('never calls the plugin on a non-Android host', async () => {
    android.value = false
    guard.status.mockResolvedValue({ usageAccess: false, accessibility: false })
    await mount()
    await foreground()
    expect(banner()).toBeNull()
    expect(guard.status).not.toHaveBeenCalled()
  })
})
