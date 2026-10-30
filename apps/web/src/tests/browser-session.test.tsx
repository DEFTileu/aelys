import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { AuthGate } from '../components/AuthGate'
import { browserAuthStatus, clearAccessToken, getAccessToken, getSharedApiClient, login, logout, resumeBrowserSession } from '../lib/api'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const session = (access_token = 'renewed-access') => ({ access_token, device_id: 'browser-device', token_type: 'bearer' })
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); clearAccessToken(false) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

async function mount() {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  const mounted = vi.fn()
  function Protected() { useEffect(() => { mounted() }, []); return <div>Finance workspace</div> }
  await act(async () => { root!.render(<AuthGate apiStatus="ready"><Protected /></AuthGate>) })
  return { host, mounted }
}

describe('shared browser session', () => {
  it('keeps refresh credentials out of JS storage and restores after losing the access token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/status')) return json({ initialized: true, can_resume: true })
      return json(session())
    })
    vi.stubGlobal('fetch', fetchImpl)
    await login('owner@example.test', 'password-example')
    expect(getAccessToken()).toBe('renewed-access')
    expect(Object.keys(localStorage)).toEqual([])
    expect(Object.keys(sessionStorage)).toEqual(['aelys.accessToken'])
    clearAccessToken(false)
    expect((await browserAuthStatus()).can_resume).toBe(true)
    expect(await resumeBrowserSession()).toBe(true)
    expect(getAccessToken()).toBe('renewed-access')
    expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true)
  })

  it('refreshes once for concurrent 401s and retries with the current access token', async () => {
    sessionStorage.setItem('aelys.accessToken', 'expired-access')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/refresh')) return json(session())
      return new Headers(init?.headers).get('Authorization') === 'Bearer renewed-access'
        ? json({ id: 'owner', email: 'owner@example.test', device_id: 'browser-device' })
        : json({ detail: { code: 'UNAUTHORIZED', message: 'Expired' } }, 401)
    })
    vi.stubGlobal('fetch', fetchImpl)
    const client = getSharedApiClient()
    const owners = await Promise.all([client.me(), client.me(), client.me()])
    expect(owners.every((owner) => owner.id === 'owner')).toBe(true)
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/refresh'))).toHaveLength(1)
    expect(getAccessToken()).toBe('renewed-access')
  })

  it('returns to sign in on a rejected refresh instead of leaving modules in an error state', async () => {
    sessionStorage.setItem('aelys.accessToken', 'old-access')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/me') ? json({ id: 'owner' }) : json({ detail: { code: 'UNAUTHORIZED', message: 'Revoked' } }, 401))
    vi.stubGlobal('fetch', fetchImpl)
    const { host } = await mount()
    expect(host.textContent).toContain('Finance workspace')
    await act(async () => { expect(await resumeBrowserSession()).toBe(false) })
    expect(host.textContent).toContain('Войти в Aelys')
    expect(host.textContent).not.toContain('Finance workspace')
    expect(getAccessToken()).toBeUndefined()
  })

  it('preserves the write body and idempotency key across a single auth retry', async () => {
    sessionStorage.setItem('aelys.accessToken', 'expired-access')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/refresh')) return json(session())
      return new Headers(init?.headers).get('Authorization') === 'Bearer renewed-access'
        ? json({ id: 'saved-task', title: 'Keep the original write' })
        : json({ detail: { code: 'UNAUTHORIZED', message: 'Expired' } }, 401)
    })
    vi.stubGlobal('fetch', fetchImpl)
    const saved = await getSharedApiClient().createTask({ title: 'Keep the original write' }, { queueOnOffline: false, idempotencyKey: 'auth-retry-task' })
    expect(saved.id).toBe('saved-task')
    const writes = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/tasks'))
    expect(writes).toHaveLength(2)
    for (const [, init] of writes) {
      expect(init?.body).toBe(JSON.stringify({ title: 'Keep the original write' }))
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('auth-retry-task')
    }
  })

  it('preserves the local session when refresh fails because the network is down', async () => {
    sessionStorage.setItem('aelys.accessToken', 'old-access')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network unavailable') }))
    await expect(resumeBrowserSession()).rejects.toThrow('Network unavailable')
    expect(getAccessToken()).toBe('old-access')
  })

  it('does not restore a cookie after signing out offline or in another tab', async () => {
    sessionStorage.setItem('aelys.accessToken', 'old-access')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Offline') }))
    await expect(logout()).rejects.toThrow('Offline')
    expect(getAccessToken()).toBeUndefined()
    expect(await resumeBrowserSession()).toBe(false)
  })
})

describe('entry gate', () => {
  it('mounts no modules until a single login succeeds and preserves the requested route', async () => {
    history.replaceState({}, '', '/finance')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/status') ? json({ initialized: true, can_resume: false }) : json(session()))
    vi.stubGlobal('fetch', fetchImpl)
    const { host, mounted } = await mount()
    expect(mounted).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Войти в Aelys')
    const inputs = host.querySelectorAll('input')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(inputs[0], 'owner@example.test'); inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
      set.call(inputs[1], 'password-example'); inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Finance workspace')
    expect(location.pathname).toBe('/finance')
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/login'))).toHaveLength(1)
  })

  it('automatically offers setup only for an uninitialized instance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ initialized: false, can_resume: false })))
    const { host, mounted } = await mount()
    expect(host.textContent).toContain('Создать аккаунт')
    expect(mounted).not.toHaveBeenCalled()
  })

  it('restores the cookie without a login form after reopening the browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/status') ? json({ initialized: true, can_resume: true }) : json(session())))
    const { host, mounted } = await mount()
    expect(host.textContent).toContain('Finance workspace')
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBe('renewed-access')
  })

  it('reports a wrong password without mounting private modules', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'UNAUTHORIZED', message: 'Wrong password' } }, 401)))
    await expect(login('owner@example.test', 'wrong-password')).rejects.toBeInstanceOf(ApiError)
    expect(getAccessToken()).toBeUndefined()
  })
})
