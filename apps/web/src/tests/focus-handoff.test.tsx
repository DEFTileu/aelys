import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setUnlockHandoff, takeUnlockHandoff, subscribeUnlockHandoff } from '../lib/focusHandoff'
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
vi.mock('../components/AndroidUpdateNotice', () => ({ AndroidUpdateNotice: () => null }))

describe('unlock handoff helper', () => {
  beforeEach(() => { takeUnlockHandoff() })
  it('hands the id out once', () => {
    expect(takeUnlockHandoff()).toBeNull()
    setUnlockHandoff('instagram')
    expect(takeUnlockHandoff()).toBe('instagram')
    expect(takeUnlockHandoff()).toBeNull()
  })
  it('keeps the id until someone takes it and tells subscribers', () => {
    const listener = vi.fn()
    const off = subscribeUnlockHandoff(listener)
    setUnlockHandoff('tiktok')
    expect(listener).toHaveBeenCalledTimes(1)
    off(); setUnlockHandoff('tiktok')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(takeUnlockHandoff()).toBe('tiktok')
  })
})

describe('App unlock handoff', () => {
  let root: ReturnType<typeof createRoot>
  let host: HTMLDivElement
  beforeEach(() => {
    takeUnlockHandoff(); vi.clearAllMocks(); android.value = true
    history.replaceState({}, '', '/apps')
    client.focusOverview.mockResolvedValue({ day_unlocked: false, ai_grants_left: 3, requests_left: 10, config: { effective: { apps: [{ id: 'instagram', label: 'Instagram', packages: ['com.instagram.android'], limit_minutes: 60 }] }, pending: null, effective_from: null } })
    client.focusRequests.mockResolvedValue([])
    guard.status.mockResolvedValue({ usageAccess: true, accessibility: true }); guard.usage.mockResolvedValue({}); guard.takePendingUnlock.mockResolvedValue(null)
  })
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; history.replaceState({}, '', '/') })
  const mount = async () => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<App />)) }

  // The screen is a lazy chunk and loads its data first, so wait for the panel itself.
  const panel = () => vi.waitFor(async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }); expect(host.querySelector('section[aria-label="Unlock Instagram"]')).not.toBeNull() }, { timeout: 3000 })

  it('opens the app limits screen with the unlock panel when the phone has a pending unlock', async () => {
    await mount()
    expect(host.textContent).toContain('Shell: /apps')
    guard.takePendingUnlock.mockResolvedValue('instagram')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await panel()
    expect(window.location.pathname).toBe('/app-limits')
    expect(host.textContent).toContain('Shell: /app-limits')
  })

  it('also checks on open', async () => {
    guard.takePendingUnlock.mockResolvedValueOnce('instagram')
    await mount()
    await panel()
    expect(window.location.pathname).toBe('/app-limits')
  })

  it('never calls the plugin on a non-Android host', async () => {
    android.value = false
    await mount()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')) })
    expect(guard.takePendingUnlock).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/apps')
  })
})
