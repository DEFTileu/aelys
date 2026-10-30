import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, args?: Record<string, unknown>) => {
  const operation = args?.operation as { type?: string } | undefined
  if (operation?.type === 'me') return { id: 'owner-1', email: 'owner@example.test', device_id: 'device-1' }
  if (operation?.type === 'projects' || operation?.type === 'tasks') return []
  return { id: 'task-1', version: 1, title: 'Native task', description: '', status: 'todo', priority: 0 }
}))

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(), invoke,
}))

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.resetModules()
  invoke.mockClear()
})

describe('native API integration', () => {
  it('uses typed Tauri operations after native authentication, never browser fetch', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { getSharedApiClient } = await import('../lib/api')
    await expect(getSharedApiClient().tasks()).resolves.toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('native_operation', {
      origin: 'http://127.0.0.1:8000', operation: { type: 'tasks' },
    })
  })

  it('signs out through native IPC before clearing the client and notifying the UI', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    localStorage.setItem('aelys.apiBaseUrl', 'https://example.test/api/v1')
    sessionStorage.setItem('aelys.accessToken', 'existing')
    let complete!: () => void
    invoke.mockReturnValueOnce(new Promise((resolve) => { complete = () => resolve([]) }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { getSharedApiClient, isSignedOut, logout, SESSION_EVENT, clearNativeSignedOut } = await import('../lib/api')
    const before = getSharedApiClient()
    const listener = vi.fn()
    window.addEventListener(SESSION_EVENT, listener)
    const pending = logout()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('native_logout', { origin: 'https://example.test' }))
    expect(isSignedOut()).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(getSharedApiClient()).toBe(before)
    complete()
    await pending
    expect(isSignedOut()).toBe(true)
    expect(sessionStorage.getItem('aelys.accessToken')).toBeNull()
    expect(getSharedApiClient()).not.toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    clearNativeSignedOut()
    expect(isSignedOut()).toBe(false)
    window.removeEventListener(SESSION_EVENT, listener)
    fetchSpy.mockRestore()
  })

  it('preserves UI session and client when native logout is denied', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    sessionStorage.setItem('aelys.accessToken', 'existing')
    invoke.mockRejectedValueOnce('KEYCHAIN_ACCESS_REQUIRED')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { getSharedApiClient, isSignedOut, logout, SESSION_EVENT } = await import('../lib/api')
    const before = getSharedApiClient()
    const listener = vi.fn()
    window.addEventListener(SESSION_EVENT, listener)
    await expect(logout()).rejects.toBe('KEYCHAIN_ACCESS_REQUIRED')
    expect(isSignedOut()).toBe(false)
    expect(sessionStorage.getItem('aelys.accessToken')).toBe('existing')
    expect(getSharedApiClient()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    window.removeEventListener(SESSION_EVENT, listener)
    fetchSpy.mockRestore()
  })

  it('clears the UI after local-only logout and propagates the revocation failure', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    sessionStorage.setItem('aelys.accessToken', 'existing')
    invoke.mockRejectedValueOnce('LOCAL_LOGOUT_ONLY')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { getSharedApiClient, isSignedOut, logout, SESSION_EVENT } = await import('../lib/api')
    const before = getSharedApiClient()
    const listener = vi.fn()
    window.addEventListener(SESSION_EVENT, listener)
    await expect(logout()).rejects.toBe('LOCAL_LOGOUT_ONLY')
    expect(isSignedOut()).toBe(true)
    expect(sessionStorage.getItem('aelys.accessToken')).toBeNull()
    expect(getSharedApiClient()).not.toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    window.removeEventListener(SESSION_EVENT, listener)
    fetchSpy.mockRestore()
  })
})
