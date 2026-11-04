import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ store: vi.fn(), client: vi.fn() }))
vi.mock('@aelys/shared', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, IndexedDbOfflineStore: class { constructor(name: string) { mocks.store(name) } }, ApiClient: class { constructor(options: unknown) { mocks.client(options) } clearReadCache() {} } }
})

const token = (owner: string) => `header.${btoa(JSON.stringify({ sub: owner }))}.signature`
beforeEach(() => { vi.resetModules(); mocks.store.mockClear(); mocks.client.mockClear(); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks() })

describe('private offline cache namespaces', () => {
  it('uses the offline hint for remote servers while allowing a reachable local backend', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const api = await import('../lib/api')
    api.getSharedApiClient()
    expect(mocks.client.mock.calls[0][0].isOnline()).toBe(true)
    api.saveApiBaseUrl('https://remote.example.test/api/v1')
    api.getSharedApiClient()
    expect(mocks.client.mock.calls[1][0].isOnline()).toBe(false)
  })

  it('separates backends and owners without opening the legacy unscoped database', async () => {
    const api = await import('../lib/api')
    sessionStorage.setItem('aelys.accessToken', token('owner-one'))
    const first = api.getSharedApiClient()
    expect(mocks.client.mock.calls[0][0]).toMatchObject({ readFreshnessMs: 60_000 })
    expect(api.getSharedApiClient()).toBe(first)
    sessionStorage.setItem('aelys.accessToken', token('owner-two'))
    expect(api.getSharedApiClient()).not.toBe(first)
    api.saveApiBaseUrl('https://isolated.example.test/api/v1')
    sessionStorage.setItem('aelys.accessToken', token('owner-two'))
    api.getSharedApiClient()
    const names = mocks.store.mock.calls.map(([name]) => name)
    expect(new Set(names).size).toBe(3)
    expect(names.every(name => name.startsWith('aelys-shared-v3:'))).toBe(true)
    expect(names[2]).toContain(encodeURIComponent('https://isolated.example.test'))
  })

  it('does not create a private cache without a usable owner namespace', async () => {
    const api = await import('../lib/api')
    sessionStorage.setItem('aelys.accessToken', 'malformed')
    api.getSharedApiClient()
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.client.mock.calls[0][0].offlineStore).toBeUndefined()
  })

  it('keeps a per-owner offline store for native sessions once the owner is known', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    try {
      const api = await import('../lib/api')
      api.getSharedApiClient()
      expect(mocks.client.mock.calls[0][0].offlineStore).toBeUndefined()
      api.setNativeCacheOwner('owner-one')
      api.getSharedApiClient()
      expect(mocks.store).toHaveBeenCalledTimes(1)
      expect(mocks.store.mock.calls[0][0]).toBe(`aelys-shared-v3:${encodeURIComponent('http://127.0.0.1:8000')}:owner-one`)
      expect(mocks.client.mock.calls[1][0].offlineStore).toBeDefined()
      const canUseCache = mocks.client.mock.calls[1][0].canUseCache as () => boolean
      expect(canUseCache()).toBe(true)
      api.setNativeCacheOwner('owner-two')
      expect(canUseCache()).toBe(false)
    } finally { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ }
  })

  it('does not send a new server or owner credential from an old client', async () => {
    const api = await import('../lib/api')
    sessionStorage.setItem('aelys.accessToken', token('owner-one'))
    api.getSharedApiClient()
    const getToken = mocks.client.mock.calls[0][0].getToken as () => string | undefined
    const canUseCache = mocks.client.mock.calls[0][0].canUseCache as () => boolean
    expect(getToken()).toBe(token('owner-one'))
    expect(canUseCache()).toBe(true)
    sessionStorage.setItem('aelys.accessToken', token('owner-two'))
    expect(getToken()).toBeUndefined()
    expect(canUseCache()).toBe(false)
    api.saveApiBaseUrl('https://another.example.test/api/v1')
    sessionStorage.setItem('aelys.accessToken', token('owner-one'))
    expect(getToken()).toBeUndefined()
    expect(canUseCache()).toBe(false)
  })
})
