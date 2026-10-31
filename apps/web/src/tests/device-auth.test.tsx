import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from '../components/AuthGate'
import * as localBrowserLogin from '../lib/localBrowserLogin'
import { claimSetupToken, clearAccessToken, deviceLogin, getAccessToken, hasDeviceIdentity, logout, resumeBrowserSession, setIdentityStore, signInWithThisDevice } from '../lib/api'
import { generateDeviceKey, signWithDeviceKey, type DeviceIdentity, type IdentityStore } from '../lib/deviceKey'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))

function memoryStore(): IdentityStore & { value?: DeviceIdentity } {
  const store: IdentityStore & { value?: DeviceIdentity } = {
    load: async () => store.value,
    save: async (identity) => { store.value = identity },
    clear: async () => { store.value = undefined },
  }
  return store
}

/** Verifies like the server does: the stored point and a raw r||s ES256 signature over the exact message. */
async function serverVerifies(publicKey: string, message: string, signature: string) {
  const key = await crypto.subtle.importKey('raw', unb64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64(signature), new TextEncoder().encode(message))
}

let root: ReturnType<typeof createRoot> | undefined
let store: ReturnType<typeof memoryStore>
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); clearAccessToken(false)
  vi.stubGlobal('indexedDB', {})
  store = memoryStore(); setIdentityStore(store)
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

describe('device key', () => {
  it('creates a P-256 key whose public point and raw signature the server can verify', async () => {
    const { privateKey, publicKey } = await generateDeviceKey()
    expect(unb64(publicKey)).toHaveLength(65)
    expect(unb64(publicKey)[0]).toBe(4)
    const signature = await signWithDeviceKey(privateKey, 'aelys-device-login-v1\ndevice\nnonce')
    expect(unb64(signature)).toHaveLength(64)
    expect(await serverVerifies(publicKey, 'aelys-device-login-v1\ndevice\nnonce', signature)).toBe(true)
    expect(await serverVerifies(publicKey, 'another message', signature)).toBe(false)
    expect(privateKey.extractable).toBe(false)
  })
})

describe('setup token and device sign-in', () => {
  it('claims ownership with a token, keeps only the key, and signs challenges afterwards', async () => {
    const seen: { path: string; body: Record<string, string> }[] = []
    let enrolledKey = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^.*\/api\/v1\//, '')
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      seen.push({ path, body })
      if (path === 'auth/setup/claim') { enrolledKey = body.public_key; return json({ access_token: 'claimed-access', refresh_token: 'never-stored', device_id: 'device-1', token_type: 'bearer' }) }
      if (path === 'auth/device/challenge') return json({ challenge_id: 'challenge-1', nonce: 'nonce-1', expires_at: 'soon' })
      if (path === 'auth/device/login') {
        const ok = await serverVerifies(enrolledKey, 'aelys-device-login-v1\ndevice-1\nnonce-1', body.signature)
        return ok ? json({ access_token: 'signed-in-access', refresh_token: 'never-stored', device_id: 'device-1', token_type: 'bearer' }) : json({ detail: { code: 'UNAUTHORIZED', message: 'Signature rejected' } }, 401)
      }
      return json({})
    }))
    await claimSetupToken('  setup-token-0123456789abcdef  ', 'Chrome (MacIntel)')
    expect(seen[0]).toMatchObject({ path: 'auth/setup/claim', body: { token: 'setup-token-0123456789abcdef', platform: 'web', display_name: 'Chrome (MacIntel)' } })
    expect(getAccessToken()).toBe('claimed-access')
    expect(store.value?.deviceId).toBe('device-1')
    expect(Object.keys(localStorage)).toEqual([])
    expect(JSON.stringify([...Object.values(sessionStorage)])).not.toContain('never-stored')

    clearAccessToken(false)
    expect(await hasDeviceIdentity()).toBe(true)
    expect(await deviceLogin()).toBe(true)
    expect(getAccessToken()).toBe('signed-in-access')
    clearAccessToken(false)
    expect(await resumeBrowserSession()).toBe(true)
    expect(getAccessToken()).toBe('signed-in-access')
  })

  it('forgets a device the server no longer knows, and keeps it when only the signature step fails', async () => {
    store.value = { deviceId: 'device-1', origin: location.origin, publicKey: 'x', privateKey: (await generateDeviceKey()).privateKey }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/challenge') ? json({ challenge_id: 'c', nonce: 'n', expires_at: 'x' }) : json({ detail: { code: 'UNAUTHORIZED', message: 'no' } }, 401)))
    expect(await deviceLogin()).toBe(false)
    expect(store.value).toBeDefined()
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'UNAUTHORIZED', message: 'Unknown or revoked device' } }, 401)))
    expect(await deviceLogin()).toBe(false)
    expect(store.value).toBeUndefined()
  })

  it('never presents a key to a different server', async () => {
    store.value = { deviceId: 'device-1', origin: 'https://elsewhere.example', publicKey: 'x', privateKey: (await generateDeviceKey()).privateKey }
    const fetchImpl = vi.fn(async () => json({}))
    vi.stubGlobal('fetch', fetchImpl)
    expect(await hasDeviceIdentity()).toBe(false)
    expect(await deviceLogin()).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('signs out without a cookie by revoking the session bearer, and signs back in only on request', async () => {
    store.value = { deviceId: 'device-1', origin: location.origin, publicKey: 'x', privateKey: (await generateDeviceKey()).privateKey }
    sessionStorage.setItem('aelys.accessToken', 'live-access')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^.*\/api\/v1\//, '')
      calls.push(`${path}|${new Headers(init?.headers).get('Authorization') ?? ''}`)
      if (path === 'auth/device/challenge') return json({ challenge_id: 'c', nonce: 'n', expires_at: 'x' })
      if (path === 'auth/device/login') return json({ access_token: 'again', refresh_token: 'r', device_id: 'device-1', token_type: 'bearer' })
      return json({ logged_out: true })
    }))
    await logout()
    expect(calls).toEqual(['auth/logout|Bearer live-access'])
    expect(getAccessToken()).toBeUndefined()
    expect(await resumeBrowserSession()).toBe(false)
    expect(await signInWithThisDevice()).toBe(true)
    expect(getAccessToken()).toBe('again')
  })
})

describe('entry gate token screen', () => {
  async function mountGate(statusBody: Record<string, unknown>, extra?: (path: string, body: Record<string, string>) => Response | undefined) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^.*\/api\/v1\//, '')
      if (path.endsWith('auth/browser/status')) return json(statusBody)
      return extra?.(path, init?.body ? JSON.parse(String(init.body)) : {}) ?? json({})
    }))
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    const mounted = vi.fn()
    function Protected() { useEffect(() => { mounted() }, []); return <div>Private workspace</div> }
    await act(async () => { root!.render(<AuthGate apiStatus="ready"><Protected /></AuthGate>) })
    return { host, mounted }
  }
  const type = async (input: Element, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('asks a fresh server for its setup token first and hides password creation when the server disallows it', async () => {
    const { host } = await mountGate({ initialized: false, can_resume: false, password_setup: false })
    expect(host.textContent).toContain('Токен установки')
    expect(host.textContent).not.toContain('Создать аккаунт с паролем')
    expect(host.querySelector('input[type=email]')).toBeNull()
  })

  it('offers password creation as the secondary path only while the server still allows it', async () => {
    const { host } = await mountGate({ initialized: false, can_resume: false, password_setup: true })
    expect(host.textContent).toContain('Создать аккаунт с паролем')
  })

  it('unlocks the workspace after a valid token and shows a clear message for a bad one', async () => {
    let attempts = 0
    const { host, mounted } = await mountGate({ initialized: false, can_resume: false, password_setup: false }, (path) => {
      if (path !== 'auth/setup/claim') return undefined
      attempts += 1
      return attempts === 1 ? json({ detail: { code: 'INVALID_SETUP_TOKEN', message: 'x' } }, 401) : json({ access_token: 'claimed', refresh_token: 'r', device_id: 'd1', token_type: 'bearer' })
    })
    const submit = async () => {
      await act(async () => {
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 100)) // key generation and the request settle asynchronously
      })
    }
    await type(host.querySelector('#aelys-entry-token')!, 'token-0123456789abcdefghij')
    await submit()
    expect(host.textContent).toContain('Токен недействителен')
    expect(mounted).not.toHaveBeenCalled()
    await submit()
    expect(host.textContent).toContain('Private workspace')
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(store.value?.deviceId).toBe('d1')
  })

  it('lets a registered device sign back in with one tap and offers the token for an existing owner', async () => {
    store.value = { deviceId: 'device-1', origin: location.origin, publicKey: 'x', privateKey: (await generateDeviceKey()).privateKey }
    localStorage.setItem('aelys.signedOut', '1')
    const { host, mounted } = await mountGate({ initialized: true, can_resume: false, password_setup: false }, (path) => {
      if (path === 'auth/device/challenge') return json({ challenge_id: 'c', nonce: 'n', expires_at: 'x' })
      if (path === 'auth/device/login') return json({ access_token: 'again', refresh_token: 'r', device_id: 'device-1', token_type: 'bearer' })
      return undefined
    })
    expect(host.textContent).toContain('Войти с этим устройством')
    expect(host.textContent).toContain('Войти по токену установки')
    expect(mounted).not.toHaveBeenCalled()
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Войти с этим устройством'))!.click()
      await new Promise((resolve) => setTimeout(resolve, 50)) // signing and two requests settle asynchronously
    })
    expect(host.textContent).toContain('Private workspace')
    expect(mounted).toHaveBeenCalledTimes(1)
  })
})


it('requires a new local launch to enter explicitly even with a saved device key', async () => {
  const launch = vi.spyOn(localBrowserLogin, 'localBrowserLaunchId').mockReturnValue('launch-one')
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/challenge')
    ? json({ nonce: 'challenge', expires_at: '2026-12-01T00:00:00Z' })
    : json({ access_token: 'device-access', device_id: 'device-one', token_type: 'bearer' }))
  vi.stubGlobal('fetch', fetchImpl)
  await claimSetupToken('token', 'Local device')
  expect(getAccessToken()).toBe('device-access')
  launch.mockReturnValue('launch-two')
  expect(getAccessToken()).toBeUndefined()
  fetchImpl.mockClear()
  expect(await resumeBrowserSession()).toBe(false)
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await signInWithThisDevice()).toBe(true)
  expect(getAccessToken()).toBe('device-access')
})
