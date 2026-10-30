import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ store: vi.fn(), client: vi.fn() }))
vi.mock('@aelys/shared', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, IndexedDbOfflineStore: class { constructor(name: string) { mocks.store(name) } }, ApiClient: class { constructor(options: unknown) { mocks.client(options) } } }
})

const token = (owner: string) => `header.${btoa(JSON.stringify({ sub: owner }))}.signature`
beforeEach(() => { vi.resetModules(); mocks.store.mockClear(); mocks.client.mockClear(); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('private offline cache namespaces', () => {
  it('separates backends and owners without opening the legacy unscoped database', async () => {
    const api = await import('../lib/api')
    sessionStorage.setItem('aelys.accessToken', token('owner-one'))
    const first = api.getSharedApiClient()
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

  it('does not send a new server or owner credential from an old client', async () => {
    const api = await import('../lib/api')
    sessionStorage.setItem('aelys.accessToken', token('owner-one'))
    api.getSharedApiClient()
    const getToken = mocks.client.mock.calls[0][0].getToken as () => string | undefined
    expect(getToken()).toBe(token('owner-one'))
    sessionStorage.setItem('aelys.accessToken', token('owner-two'))
    expect(getToken()).toBeUndefined()
    api.saveApiBaseUrl('https://another.example.test/api/v1')
    sessionStorage.setItem('aelys.accessToken', token('owner-one'))
    expect(getToken()).toBeUndefined()
  })
})
