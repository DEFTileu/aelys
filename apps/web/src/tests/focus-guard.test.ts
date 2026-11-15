import { ApiClient, OfflineWriteUnavailableError, type FocusOverview } from '@aelys/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { focusGuard, localDay, syncGuard } from '../lib/focusGuard'

const app = (id: string, minutes = 30) => ({ id, label: id, packages: [`com.${id}.app`], limit_minutes: minutes })
const overview = (over: Partial<FocusOverview> = {}): FocusOverview => ({
  day_unlocked: false, ai_grants_left: 3, requests_left: 5,
  config: { effective: { apps: [app('insta')] }, pending: null, effective_from: null },
  ...over,
})

beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue({}) })

describe('localDay', () => {
  it('uses the device calendar, not UTC', () => {
    const late = new Date(2026, 10, 5, 23, 30) // local 23:30 on Nov 5
    expect(localDay(late)).toBe('2026-11-05')
    const justAfterMidnight = new Date(2026, 0, 1, 0, 15)
    expect(localDay(justAfterMidnight)).toBe('2026-01-01')
    // Where the machine is not on UTC the UTC date differs late in the evening (west) or just after midnight (east); never fail on a UTC machine.
    const utc = (d: Date) => d.toISOString().slice(0, 10)
    if (utc(late) !== '2026-11-05') expect(utc(late)).not.toBe(localDay(late))
    if (utc(justAfterMidnight) !== '2026-01-01') expect(utc(justAfterMidnight)).not.toBe(localDay(justAfterMidnight))
  })
  it('defaults to today and zero pads', () => {
    expect(localDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(localDay(new Date(2026, 2, 4))).toBe('2026-03-04')
  })
})

describe('syncGuard', () => {
  it('sends dayUnlockedOn only when the day is unlocked', async () => {
    await syncGuard(overview({ day_unlocked: false }))
    expect(invoke).toHaveBeenLastCalledWith('plugin:aelys-focus-guard|set_state', { state: expect.objectContaining({ dayUnlockedOn: null }) })
    await syncGuard(overview({ day_unlocked: true }))
    expect(invoke).toHaveBeenLastCalledWith('plugin:aelys-focus-guard|set_state', { state: expect.objectContaining({ dayUnlockedOn: localDay() }) })
  })

  it('maps the backend shape to the plugin shape and preserves pending null vs []', async () => {
    await syncGuard(overview())
    expect(invoke).toHaveBeenLastCalledWith('plugin:aelys-focus-guard|set_state', {
      state: { effective: [app('insta')], pending: null, effectiveFrom: null, dayUnlockedOn: null },
    })
    await syncGuard(overview({ config: { effective: { apps: [app('insta')] }, pending: { apps: [] }, effective_from: '2026-11-16' } }))
    expect(invoke).toHaveBeenLastCalledWith('plugin:aelys-focus-guard|set_state', {
      state: { effective: [app('insta')], pending: [], effectiveFrom: '2026-11-16', dayUnlockedOn: null },
    })
    await syncGuard(overview({ config: { effective: { apps: [] }, pending: { apps: [app('tiktok', 10)] }, effective_from: '2026-11-16' } }))
    expect(invoke).toHaveBeenLastCalledWith('plugin:aelys-focus-guard|set_state', {
      state: { effective: [], pending: [app('tiktok', 10)], effectiveFrom: '2026-11-16', dayUnlockedOn: null },
    })
  })

  it('refuses a missing overview', async () => {
    for (const bad of [undefined, null, {}, { day_unlocked: true }, { config: {} }, { config: { effective: null } }]) {
      await expect(syncGuard(bad as unknown as FocusOverview)).rejects.toThrow()
    }
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('focusGuard', () => {
  it('calls the plugin commands with snake_case names and the camelCase appId', async () => {
    invoke.mockResolvedValue({})
    await focusGuard.status()
    await focusGuard.openSettings('usage')
    await focusGuard.applyGrant('insta', 300, '2026-11-15')
    await focusGuard.installedApps()
    await focusGuard.takePendingUnlock()
    expect(invoke.mock.calls).toEqual([
      ['plugin:aelys-focus-guard|status', undefined],
      ['plugin:aelys-focus-guard|open_settings', { target: 'usage' }],
      ['plugin:aelys-focus-guard|apply_grant', { appId: 'insta', seconds: 300, day: '2026-11-15' }],
      ['plugin:aelys-focus-guard|installed_apps', undefined],
      ['plugin:aelys-focus-guard|take_pending_unlock', undefined],
    ])
  })

  it('unwraps the usage and pending-unlock payloads', async () => {
    const usage = { insta: { usedSeconds: 60, limitSeconds: 1800, grantedSeconds: 0 } }
    invoke.mockResolvedValueOnce({ usage })
    expect(await focusGuard.usage()).toEqual(usage)
    expect(invoke).toHaveBeenLastCalledWith('plugin:aelys-focus-guard|usage', undefined)
    invoke.mockResolvedValueOnce({ appId: 'insta' })
    expect(await focusGuard.takePendingUnlock()).toBe('insta')
    invoke.mockResolvedValueOnce({ appId: null })
    expect(await focusGuard.takePendingUnlock()).toBeNull()
    invoke.mockResolvedValueOnce({ apps: [{ pkg: 'a.b', label: 'A' }] })
    expect(await focusGuard.installedApps()).toEqual([{ pkg: 'a.b', label: 'A' }])
  })
})

describe('focus client methods', () => {
  const setup = () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({})))
    return { fetchImpl, client: new ApiClient({ baseUrl: 'https://api.example.test', fetch: fetchImpl }) }
  }
  const lastCall = (f: ReturnType<typeof setup>['fetchImpl']) => (f.mock.calls as unknown as [string, RequestInit][]).at(-1)!

  it('focusOverview reads /focus/state for the day', async () => {
    const { client, fetchImpl } = setup()
    await client.focusOverview('2026-11-15')
    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://api.example.test/api/v1/focus/state?day=2026-11-15')
    expect(init.method).toBe('GET')
  })

  it('saveFocusConfig PUTs the config with the day', async () => {
    const { client, fetchImpl } = setup()
    const config = { apps: [app('insta')] }
    await client.saveFocusConfig(config, '2026-11-15')
    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://api.example.test/api/v1/focus/config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ config, day: '2026-11-15' })
  })

  it('focusUnlock POSTs the request and is never queued offline', async () => {
    const { client, fetchImpl } = setup()
    const body = { day: '2026-11-15', app_id: 'insta', reason: 'need to message a client' }
    await client.focusUnlock(body)
    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://api.example.test/api/v1/focus/unlock-request')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(body)
    const offline = new ApiClient({ baseUrl: 'https://api.example.test', fetch: vi.fn(async () => { throw new Error('offline') }) })
    await expect(offline.focusUnlock(body)).rejects.toBeInstanceOf(OfflineWriteUnavailableError)
  })

  it('focusRequests passes the limit only when given', async () => {
    const { client, fetchImpl } = setup()
    await client.focusRequests()
    expect(lastCall(fetchImpl)[0]).toBe('https://api.example.test/api/v1/focus/requests')
    await client.focusRequests(20)
    expect(lastCall(fetchImpl)[0]).toBe('https://api.example.test/api/v1/focus/requests?limit=20')
  })
})
