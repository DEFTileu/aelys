import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiHealth } from '../lib/apiHealth'
import type { ApiStatus } from '../types'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  let baseUrl = '/api/v1'
  let online = true
  let time = 0
  const changes: ApiStatus[] = []
  const check = vi.fn<(_config: { baseUrl: string }) => Promise<void>>()
  const health = createApiHealth({ getConfig: () => ({ baseUrl }), isOnline: () => online, publish: (status) => changes.push(status), check, now: () => time })
  return { health, check, changes, setBase: (value: string) => { baseUrl = value }, setOnline: (value: boolean) => { online = value }, setTime: (value: number) => { time = value } }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('API health controller', () => {
  it('coalesces a burst, retains ready, and skips only fresh focus checks', async () => {
    const s = setup()
    const first = deferred()
    s.check.mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const requests = [s.health.refresh('force'), s.health.refresh('focus'), s.health.refresh('force')]
    await Promise.resolve()
    expect(s.check).toHaveBeenCalledTimes(1) // three triggers, one network request
    first.resolve(); await Promise.all(requests)
    expect(s.changes).toEqual(['ready'])
    s.setTime(29_999)
    await s.health.refresh('focus')
    expect(s.check).toHaveBeenCalledTimes(1)
    await s.health.refresh('force') // manual check bypasses freshness
    expect(s.check).toHaveBeenCalledTimes(2)
    expect(s.changes).toEqual(['ready']) // no loading bounce
    s.setTime(60_000)
    await s.health.refresh('focus')
    expect(s.check).toHaveBeenCalledTimes(3)
  })

  it.each([true, false])('ignores old configuration results regardless of completion order (%s)', async (oldFirst) => {
    const s = setup()
    const old = deferred(); const current = deferred()
    s.check.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const a = s.health.refresh('force'); await Promise.resolve()
    s.setBase('https://new.example/api/v1/')
    const b = s.health.refresh('force'); await Promise.resolve()
    expect(s.check.mock.calls.map(([config]) => config.baseUrl)).toEqual(['/api/v1', 'https://new.example/api/v1'])
    if (oldFirst) { old.resolve(); await a; expect(s.changes).toEqual([]); current.reject(new Error('new failed')); await b }
    else { current.reject(new Error('new failed')); await b; old.resolve(); await a }
    expect(s.changes).toEqual(['error'])
  })

  it('invalidates in-flight results offline and forces a fresh check on reconnect', async () => {
    const s = setup(); const old = deferred(); const current = deferred()
    s.check.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const a = s.health.refresh('force'); await Promise.resolve()
    s.setOnline(false); s.health.offline()
    s.setOnline(true); const b = s.health.refresh('force'); await Promise.resolve()
    old.resolve(); await a
    expect(s.changes).toEqual(['offline'])
    current.resolve(); await b
    expect(s.changes).toEqual(['offline', 'ready'])
    expect(s.check).toHaveBeenCalledTimes(2)
  })

  it('publishes a background failure and permits immediate retry after an error', async () => {
    const s = setup()
    s.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(undefined)
    await s.health.refresh('force')
    s.setTime(30_000); await s.health.refresh('focus')
    expect(s.changes).toEqual(['ready', 'error'])
    await s.health.refresh('focus')
    expect(s.check).toHaveBeenCalledTimes(3)
    expect(s.changes).toEqual(['ready', 'error', 'ready'])
  })

  it('does not publish after disposal', async () => {
    const s = setup(); const pending = deferred(); s.check.mockReturnValue(pending.promise)
    const request = s.health.refresh('force'); await Promise.resolve(); s.health.dispose()
    pending.resolve(); await request
    expect(s.changes).toEqual([])
  })

  it.each([
    ['text/html', '<html></html>'],
    ['application/json', '{"status":"error"}'],
    ['application/json', 'invalid'],
  ])('rejects invalid health response %s', async (contentType, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': contentType } })))
    const changes: ApiStatus[] = []
    const health = createApiHealth({ getConfig: () => ({ baseUrl: '/api/v1' }), isOnline: () => true, publish: (status) => changes.push(status) })
    await health.refresh('force')
    expect(changes).toEqual(['error'])
  })

  it('uses an abortable 6.5 second health request and reports timeout', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetchImpl)
    const changes: ApiStatus[] = []
    const health = createApiHealth({ getConfig: () => ({ baseUrl: '/api/v1' }), isOnline: () => true, publish: (status) => changes.push(status) })
    const request = health.refresh('force'); await Promise.resolve()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/healthz')
    await vi.advanceTimersByTimeAsync(6500); await request
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(changes).toEqual(['error'])
  })
})
