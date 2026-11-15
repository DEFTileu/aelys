import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, OfflineWriteUnavailableError, type FocusApp, type FocusOverview } from '@aelys/shared'
import { FocusView } from '../views/FocusView'
import { localDay } from '../lib/focusGuard'
import { setUnlockHandoff, takeUnlockHandoff } from '../lib/focusHandoff'

const client = vi.hoisted(() => ({ focusOverview: vi.fn(), saveFocusConfig: vi.fn(), focusUnlock: vi.fn(), focusRequests: vi.fn() }))
const guard = vi.hoisted(() => ({ status: vi.fn(), openSettings: vi.fn(), setState: vi.fn(), usage: vi.fn(), applyGrant: vi.fn(), installedApps: vi.fn(), takePendingUnlock: vi.fn() }))
const sync = vi.hoisted(() => vi.fn())
const android = vi.hoisted(() => ({ value: true }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
vi.mock('../lib/notificationLog', () => ({ isAndroidHost: () => android.value }))
vi.mock('../lib/focusGuard', async (original) => ({ ...(await original<typeof import('../lib/focusGuard')>()), focusGuard: guard, syncGuard: sync }))

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
async function mount(status: 'ready' | 'offline' = 'ready') { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<FocusView apiStatus={status} />)) }
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
const click = async (label: string) => { const b = button(label); if (!b) throw new Error(`no button ${label}`); await act(async () => b.click()) }
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}

const app = (id: string, label: string, pkgs: string[], limit = 60): FocusApp => ({ id, label, packages: pkgs, limit_minutes: limit })
const INSTA = app('instagram', 'Instagram', ['com.instagram.android'])
const TIKTOK = app('tiktok', 'TikTok', ['com.ss.android.ugc.trill', 'com.zhiliaoapp.musically'])
const PDD = app('pinduoduo', 'Pinduoduo', ['com.xunmeng.pinduoduo'])
const overview = (effective: FocusApp[], pending: FocusApp[] | null = null, over: Partial<FocusOverview> = {}): FocusOverview => ({
  day_unlocked: false, ai_grants_left: 3, requests_left: 10,
  config: { effective: { apps: effective }, pending: pending ? { apps: pending } : null, effective_from: pending ? '2099-01-02' : null }, ...over,
})
const NOW = localDay()

beforeEach(() => {
  vi.resetAllMocks()
  takeUnlockHandoff()
  android.value = true
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  client.focusOverview.mockResolvedValue(overview([INSTA, TIKTOK, PDD]))
  client.focusRequests.mockResolvedValue([])
  client.saveFocusConfig.mockResolvedValue({})
  guard.status.mockResolvedValue({ usageAccess: true, accessibility: true })
  guard.usage.mockResolvedValue({})
  guard.takePendingUnlock.mockResolvedValue(null)
  guard.installedApps.mockResolvedValue([])
  guard.applyGrant.mockResolvedValue(undefined)
  guard.openSettings.mockResolvedValue(undefined)
  sync.mockResolvedValue(undefined)
})
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

describe('FocusView', () => {
  it('warns when it cannot confirm protection because status failed', async () => {
    guard.status.mockRejectedValue(new Error('plugin gone'))
    await mount()
    expect(host.textContent).toContain('Cannot confirm protection')
    expect(host.textContent).not.toContain('Protection is off')
  })

  it('shows no protection warning when everything is on', async () => {
    await mount()
    expect(host.textContent).not.toContain('Cannot confirm protection')
    expect(host.textContent).not.toContain('Protection is off')
  })

  it('remembers that limits were configured once a non-empty config loads, and never forgets it', async () => {
    localStorage.removeItem('aelys.appLimits.configured')
    client.focusOverview.mockResolvedValue(overview([]))
    await mount()
    expect(localStorage.getItem('aelys.appLimits.configured')).toBeNull()
    act(() => root.unmount())
    client.focusOverview.mockResolvedValue(overview([INSTA]))
    await mount()
    expect(localStorage.getItem('aelys.appLimits.configured')).toBe('1')
    act(() => root.unmount())
    client.focusOverview.mockResolvedValue(overview([]))
    await mount()
    expect(localStorage.getItem('aelys.appLimits.configured')).toBe('1')
    localStorage.removeItem('aelys.appLimits.configured')
  })

  it('shows protection off when accessibility is missing', async () => {
    guard.status.mockResolvedValue({ usageAccess: true, accessibility: false })
    await mount()
    expect(host.textContent).toContain('Protection is off')
    await click('Open accessibility settings')
    expect(guard.openSettings).toHaveBeenCalledWith('accessibility')
    await click('Open app settings')
    expect(guard.openSettings).toHaveBeenCalledWith('app')
    expect(host.textContent).toContain('Allow restricted settings')
  })

  it('hides the protection warning when both permissions are on', async () => {
    await mount()
    expect(host.textContent).not.toContain('Protection is off')
  })

  it('shows no usage access instead of zero minutes when usage access is missing', async () => {
    guard.status.mockResolvedValue({ usageAccess: false, accessibility: true })
    guard.usage.mockResolvedValue({ instagram: { usedSeconds: 0, limitSeconds: 3600, grantedSeconds: 0 } })
    await mount()
    expect(host.textContent).toContain('Protection is off')
    expect(host.textContent).toContain('No usage access yet')
    expect(host.textContent).not.toContain('0 min used')
    await click('Grant usage access')
    expect(guard.openSettings).toHaveBeenCalledWith('usage')
  })

  it('shows used time against limit plus grant when usage access is on', async () => {
    guard.usage.mockResolvedValue({ instagram: { usedSeconds: 1500, limitSeconds: 3600, grantedSeconds: 600 } })
    await mount()
    expect(host.textContent).toContain('25 min of 70 min')
  })

  it('offers Enable default limits only when effective is empty and nothing is pending, and saves the defaults', async () => {
    client.focusOverview.mockResolvedValueOnce(overview([]))
    await mount()
    expect(host.textContent).toContain('Enable default limits')
    await click('Enable default limits')
    expect(client.saveFocusConfig).toHaveBeenCalledWith({ apps: [
      { id: 'instagram', label: 'Instagram', packages: ['com.instagram.android'], limit_minutes: 60 },
      { id: 'tiktok', label: 'TikTok', packages: ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'], limit_minutes: 60 },
      { id: 'pinduoduo', label: 'Pinduoduo', packages: ['com.xunmeng.pinduoduo'], limit_minutes: 60 },
    ] }, NOW)
    expect(client.focusOverview).toHaveBeenCalledTimes(2) // refetched
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('does not offer defaults when apps are configured or a change is pending, and never auto-saves', async () => {
    await mount()
    expect(host.textContent).not.toContain('Enable default limits')
    act(() => root.unmount()); document.body.innerHTML = ''
    client.focusOverview.mockResolvedValue(overview([], [INSTA]))
    await mount()
    expect(host.textContent).not.toContain('Enable default limits')
    expect(client.saveFocusConfig).not.toHaveBeenCalled()
  })

  it('lists the three default apps with 60 minute limits when configured', async () => {
    await mount()
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type=number]')]
    expect(inputs.map((i) => i.value)).toEqual(['60', '60', '60'])
    for (const name of ['Instagram', 'TikTok', 'Pinduoduo']) expect(host.textContent).toContain(name)
    expect(host.textContent).toContain('Lowering a limit applies now. Raising it or removing an app applies tomorrow.')
  })

  it('raising a limit shows a pending banner and keeps the old limit as the active one', async () => {
    await mount()
    const insta = host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!
    await type(insta, '90')
    client.focusOverview.mockResolvedValue(overview([INSTA, TIKTOK, PDD], [{ ...INSTA, limit_minutes: 90 }, TIKTOK, PDD]))
    await click('Save')
    expect(client.saveFocusConfig).toHaveBeenCalledWith({ apps: [{ ...INSTA, limit_minutes: 90 }, TIKTOK, PDD] }, NOW)
    expect(host.textContent).toContain('Pending change')
    expect(host.textContent).toContain('2099-01-02')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!.value).toBe('60')
    expect(host.textContent).toContain('Instagram 90 min')
  })

  it('cancel pending change saves the current effective config', async () => {
    client.focusOverview.mockResolvedValue(overview([INSTA, TIKTOK], [{ ...INSTA, limit_minutes: 90 }, TIKTOK]))
    await mount()
    client.focusOverview.mockResolvedValue(overview([INSTA, TIKTOK]))
    await click('Cancel pending change')
    expect(client.saveFocusConfig).toHaveBeenCalledWith({ apps: [INSTA, TIKTOK] }, NOW)
    expect(host.textContent).not.toContain('Pending change')
  })

  it('lowering a limit sends the lower config and shows no pending banner', async () => {
    await mount()
    expect(button('Save')!.disabled).toBe(true)
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for TikTok in minutes"]')!, '30')
    client.focusOverview.mockResolvedValue(overview([INSTA, { ...TIKTOK, limit_minutes: 30 }, PDD]))
    await click('Save')
    expect(client.saveFocusConfig).toHaveBeenCalledWith({ apps: [INSTA, { ...TIKTOK, limit_minutes: 30 }, PDD] }, NOW)
    expect(host.textContent).not.toContain('Pending change')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for TikTok in minutes"]')!.value).toBe('30')
  })

  it('refuses limits outside 1 to 1440 minutes', async () => {
    await mount()
    for (const bad of ['0', '1441', '', '2.5']) {
      await type(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!, bad)
      expect(button('Save')!.disabled).toBe(true)
    }
  })

  it('shows readable messages for the server limit and day errors', async () => {
    await mount()
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!, '30')
    client.saveFocusConfig.mockRejectedValueOnce(new ApiError(422, 'FOCUS_LIMIT', 'At most 30 apps are allowed'))
    await click('Save')
    expect(host.textContent).toContain('At most 30 apps are allowed')
    client.saveFocusConfig.mockRejectedValueOnce(new ApiError(422, 'BAD_DAY', 'day must be today\'s date'))
    await click('Save')
    expect(host.textContent).toContain('date on this phone')
    client.saveFocusConfig.mockRejectedValueOnce(new OfflineWriteUnavailableError())
    await click('Save')
    expect(host.textContent).toContain('offline')
  })

  it('unlock panel sends the reason and applies a grant of minutes*60 seconds on approval', async () => {
    guard.takePendingUnlock.mockResolvedValue('instagram')
    client.focusUnlock.mockResolvedValue({ granted: true, minutes: 10, message: 'Fine, ten minutes.', ai_grants_left: 2, requests_left: 9 })
    await mount()
    const reason = host.querySelector<HTMLTextAreaElement>('textarea')!
    expect(reason.maxLength).toBe(300)
    expect(button('Ask for time')!.disabled).toBe(true)
    await type(reason, 'Need to reply to a client on Instagram')
    await click('Ask for time')
    expect(client.focusUnlock).toHaveBeenCalledWith({ day: NOW, app_id: 'instagram', reason: 'Need to reply to a client on Instagram' })
    expect(guard.applyGrant).toHaveBeenCalledWith('instagram', 600, NOW)
    expect(host.textContent).toContain('Fine, ten minutes.')
    expect(host.textContent).toContain('You can open Instagram for 10 minutes')
    expect(host.textContent).toContain('2 AI unlocks left today')
  })

  it('unlock panel shows the AI message and applies nothing on denial', async () => {
    guard.takePendingUnlock.mockResolvedValue('instagram')
    client.focusUnlock.mockResolvedValue({ granted: false, minutes: 0, message: 'Scrolling is not a reason.', ai_grants_left: 3, requests_left: 9 })
    await mount()
    await type(host.querySelector<HTMLTextAreaElement>('textarea')!, 'bored')
    await click('Ask for time')
    expect(host.textContent).toContain('Scrolling is not a reason.')
    expect(host.textContent).not.toContain('You can open')
    expect(guard.applyGrant).not.toHaveBeenCalled()
    expect(host.textContent).toContain('3 AI unlocks left today')
  })

  it('unlock is disabled when offline', async () => {
    guard.takePendingUnlock.mockResolvedValue('instagram')
    await mount('offline')
    await type(host.querySelector<HTMLTextAreaElement>('textarea')!, 'a real reason')
    expect(button('Ask for time')!.disabled).toBe(true)
    expect(host.textContent).toContain('offline')
  })

  it('keeps the unlock panel but disabled when the overview could not load', async () => {
    client.focusOverview.mockRejectedValue(new Error('offline'))
    guard.takePendingUnlock.mockResolvedValue('instagram')
    await mount()
    await type(host.querySelector<HTMLTextAreaElement>('textarea')!, 'a real reason')
    expect(button('Ask for time')!.disabled).toBe(true)
    expect(guard.setState).not.toHaveBeenCalled()
  })

  const refresh = async () => act(async () => { document.dispatchEvent(new Event('visibilitychange')) })

  it('disables every write after a failed refresh so stale data is never saved', async () => {
    client.focusOverview.mockResolvedValue(overview([INSTA, TIKTOK], [{ ...INSTA, limit_minutes: 90 }, TIKTOK]))
    await mount()
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for TikTok in minutes"]')!, '30')
    expect(button('Save')!.disabled).toBe(false)
    client.focusOverview.mockRejectedValue(new Error('down'))
    await refresh()
    expect(host.textContent).toContain('Could not refresh')
    expect(button('Save')!.disabled).toBe(true)
    expect(button('Cancel pending change')!.disabled).toBe(true)
    await click('Save'); await click('Cancel pending change')
    expect(client.saveFocusConfig).not.toHaveBeenCalled()
    act(() => root.unmount()); document.body.innerHTML = ''
    client.focusOverview.mockResolvedValue(overview([]))
    await mount()
    expect(button('Enable default limits')!.disabled).toBe(false)
    client.focusOverview.mockRejectedValue(new Error('down'))
    await refresh()
    expect(button('Enable default limits')!.disabled).toBe(true)
  })

  it('drops an edit when a refresh brings a different effective config', async () => {
    await mount()
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!, '30')
    expect(button('Save')!.disabled).toBe(false)
    client.focusOverview.mockResolvedValue(overview([{ ...INSTA, limit_minutes: 45 }, TIKTOK, PDD])) // e.g. another device or midnight
    await refresh()
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!.value).toBe('45')
    expect(host.textContent).toContain('Your edit was discarded')
    expect(button('Save')!.disabled).toBe(true)
    await click('Save')
    expect(client.saveFocusConfig).not.toHaveBeenCalled()
  })

  it('keeps an edit when a refresh returns the same effective config', async () => {
    await mount()
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!, '30')
    await refresh()
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Daily limit for Instagram in minutes"]')!.value).toBe('30')
    expect(button('Save')!.disabled).toBe(false)
  })

  it('applies nothing for a grant of zero minutes', async () => {
    guard.takePendingUnlock.mockResolvedValue('instagram')
    client.focusUnlock.mockResolvedValue({ granted: true, minutes: 0, message: 'Odd.', ai_grants_left: 2, requests_left: 9 })
    await mount()
    await type(host.querySelector<HTMLTextAreaElement>('textarea')!, 'reason')
    await click('Ask for time')
    expect(guard.applyGrant).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('You can open')
  })

  it('opens the unlock panel from a handoff set before it mounted, without asking the plugin', async () => {
    setUnlockHandoff('tiktok')
    await mount()
    expect(host.querySelector('section[aria-label="Unlock TikTok"]')).not.toBeNull()
    expect(guard.takePendingUnlock).not.toHaveBeenCalled()
    expect(takeUnlockHandoff()).toBeNull()
  })

  it('opens the unlock panel when a handoff arrives while it is already mounted', async () => {
    await mount()
    expect(host.querySelector('section[aria-label^="Unlock"]')).toBeNull()
    await act(async () => { setUnlockHandoff('instagram') })
    expect(host.querySelector('section[aria-label="Unlock Instagram"]')).not.toBeNull()
  })

  it('does not consume a pending unlock when the screen was left while loading', async () => {
    let finish!: (value: FocusOverview) => void
    client.focusOverview.mockReturnValue(new Promise<FocusOverview>((resolve) => { finish = resolve }))
    await mount()
    act(() => root.unmount())
    await act(async () => { finish(overview([INSTA])) })
    expect(guard.takePendingUnlock).not.toHaveBeenCalled()
  })

  it('lists the request history newest first with reason, decision and time', async () => {
    client.focusRequests.mockResolvedValue([
      { id: 'b', day: NOW, app_id: 'instagram', reason: 'newer reason', granted: false, minutes: 0, message: 'No.', created_at: '2026-11-15T12:00:00Z' },
      { id: 'a', day: NOW, app_id: 'tiktok', reason: 'older reason', granted: true, minutes: 10, message: 'Ok.', created_at: '2026-11-15T09:00:00Z' },
    ])
    await mount()
    expect(client.focusRequests).toHaveBeenCalledWith(20)
    const text = host.textContent!
    expect(text.indexOf('newer reason')).toBeGreaterThan(-1)
    expect(text.indexOf('newer reason')).toBeLessThan(text.indexOf('older reason'))
    expect(text).toContain('Refused'); expect(text).toContain('Granted 10 min')
  })

  it('a failed overview fetch never calls set_state', async () => {
    client.focusOverview.mockRejectedValue(new Error('boom'))
    await mount()
    expect(sync).not.toHaveBeenCalled()
    expect(guard.setState).not.toHaveBeenCalled()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Could not load')
    expect(host.textContent).not.toContain('Enable default limits')
  })

  it('syncGuard is called with the day used for the fetch, then pending unlock is read', async () => {
    const loaded = overview([INSTA])
    client.focusOverview.mockResolvedValue(loaded)
    await mount()
    const day = client.focusOverview.mock.calls[0]![0] as string
    expect(day).toBe(NOW)
    expect(sync).toHaveBeenCalledWith(loaded, day)
    expect(guard.takePendingUnlock).toHaveBeenCalled()
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(guard.takePendingUnlock.mock.invocationCallOrder[0]!)
  })

  it('refreshes and syncs again when the app returns to the foreground', async () => {
    await mount()
    expect(client.focusOverview).toHaveBeenCalledTimes(1)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(client.focusOverview).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('non-Android host shows the Android-only state and makes no plugin call', async () => {
    android.value = false
    await mount()
    expect(host.textContent).toContain('Available in the Android app')
    for (const fn of Object.values(guard)) expect(fn).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(client.focusOverview).not.toHaveBeenCalled()
  })
})
