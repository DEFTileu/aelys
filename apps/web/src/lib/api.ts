import type { ApiConfig } from '../types'
import { ApiClient, ApiError as SharedApiError, IndexedDbOfflineStore, type BrowserAuthStatus, type BrowserSession } from '@aelys/shared'
import { isNativeHost, loadNativeTransport, nativeBackendOrigin } from './nativeTransport'
import { createNativeFetch } from './nativeClient'
import { localBrowserLaunchId } from './localBrowserLogin'
import { generateDeviceKey, indexedDbIdentityStore, signWithDeviceKey, webCryptoAvailable, type DeviceIdentity, type IdentityStore } from './deviceKey'

const API_BASE_STORAGE_KEY = 'aelys.apiBaseUrl'
const ACCESS_TOKEN_STORAGE_KEY = 'aelys.accessToken'
const SIGNED_OUT_KEY = 'aelys.signedOut'
const LOCAL_LAUNCH_STORAGE_KEY = 'aelys.localPasswordLaunch'
const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'
export const SESSION_EVENT = 'aelys:session-changed'

export function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim()
  return trimmed ? trimmed.replace(/\/$/, '') : DEFAULT_API_BASE_URL
}

export function getApiConfig(): ApiConfig {
  if (typeof window === 'undefined') return { baseUrl: DEFAULT_API_BASE_URL }
  return { baseUrl: normalizeApiBaseUrl(window.localStorage.getItem(API_BASE_STORAGE_KEY) || DEFAULT_API_BASE_URL) }
}

export function saveApiBaseUrl(value: string): ApiConfig {
  const baseUrl = normalizeApiBaseUrl(value)
  if (getApiConfig().baseUrl !== baseUrl) clearAccessToken()
  window.localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl)
  window.dispatchEvent(new Event('aelys:check-api'))
  return { baseUrl }
}

function sharedOrigin(baseUrl: string): string {
  const normalized = normalizeApiBaseUrl(baseUrl)
  if (normalized === '/api/v1') return window.location.origin
  return normalized.replace(/\/api\/v1$/, '') || window.location.origin
}

let sharedClient: ApiClient | undefined
let sharedClientKey = ''
let refreshFlight: Promise<boolean> | undefined

function localLaunchAuthenticated(): boolean {
  const launchId = localBrowserLaunchId()
  if (!launchId) return true
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(LOCAL_LAUNCH_STORAGE_KEY) || 'null')
    return saved?.launchId === launchId && saved?.origin === sharedOrigin(getApiConfig().baseUrl)
  } catch { return false }
}

export function getAccessToken(): string | undefined {
  if (window.localStorage.getItem(SIGNED_OUT_KEY) || !localLaunchAuthenticated()) return undefined
  return window.sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || undefined
}

export function clearAccessToken(notify = true): void {
  window.sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
  window.sessionStorage.removeItem(LOCAL_LAUNCH_STORAGE_KEY)
  sharedClient = undefined; sharedClientKey = ''
  if (notify) window.dispatchEvent(new Event(SESSION_EVENT))
}

function acceptSession(session: BrowserSession, notify: boolean, explicitEntry = false): void {
  const launchId = localBrowserLaunchId()
  if (launchId && explicitEntry) {
    window.sessionStorage.setItem(LOCAL_LAUNCH_STORAGE_KEY, JSON.stringify({ launchId, origin: sharedOrigin(getApiConfig().baseUrl) }))
  }
  window.localStorage.removeItem(SIGNED_OUT_KEY)
  window.sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, session.access_token)
  if (notify) window.dispatchEvent(new Event(SESSION_EVENT))
}

async function browserRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${getApiConfig().baseUrl}/auth/browser/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: { Accept: 'application/json', 'X-Aelys-Browser': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  const value = await response.json().catch(() => undefined)
  if (!response.ok) throw new SharedApiError(response.status, value?.detail?.code ?? 'AUTH_UNAVAILABLE', value?.detail?.message ?? 'Не удалось подключиться к Aelys')
  return value as T
}

export function browserAuthStatus(): Promise<BrowserAuthStatus> { return browserRequest('status') }

// ---- key-bound device sign-in (setup token, challenge/response) -------------------------------------

interface DeviceSessionResponse extends BrowserSession { readonly device_id: string }

let identityStore: IdentityStore = indexedDbIdentityStore
/** Tests replace the IndexedDB-backed store with an in-memory one. */
export function setIdentityStore(store: IdentityStore): void { identityStore = store }

async function currentIdentity(): Promise<DeviceIdentity | undefined> {
  if (isNativeHost() || !webCryptoAvailable()) return undefined
  const identity = await identityStore.load()
  return identity && identity.origin === sharedOrigin(getApiConfig().baseUrl) ? identity : undefined
}

export async function hasDeviceIdentity(): Promise<boolean> { return !!(await currentIdentity()) }

async function deviceRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${getApiConfig().baseUrl}/${path}`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  const value = await response.json().catch(() => undefined)
  if (!response.ok) throw new SharedApiError(response.status, value?.detail?.code ?? 'AUTH_UNAVAILABLE', value?.detail?.message ?? 'Не удалось подключиться к Aelys')
  return value as T
}

/** Registers this browser as a key-bound device with a one-time setup token; no password is involved. */
export async function claimSetupToken(token: string, displayName: string): Promise<void> {
  if (isNativeHost() || !webCryptoAvailable()) throw new SharedApiError(400, 'DEVICE_KEY_UNAVAILABLE', 'Этот браузер не может хранить ключ устройства.')
  const key = await generateDeviceKey()
  const session = await deviceRequest<DeviceSessionResponse>('auth/setup/claim', { token: token.trim(), public_key: key.publicKey, platform: 'web', display_name: displayName.trim() || 'Браузер' })
  await identityStore.save({ deviceId: session.device_id, origin: sharedOrigin(getApiConfig().baseUrl), publicKey: key.publicKey, privateKey: key.privateKey })
  acceptSession(session, true, true)
}

/** Proves possession of this device's key to the server. False when there is no usable identity. */
export async function deviceLogin(): Promise<boolean> {
  const identity = await currentIdentity()
  if (!identity) return false
  const origin = identity.origin
  let challenge: { challenge_id: string; nonce: string }
  try {
    challenge = await deviceRequest('auth/device/challenge', { device_id: identity.deviceId })
  } catch (error) {
    // The server no longer knows this device (revoked or wiped): the key is useless, so forget it.
    if (error instanceof SharedApiError && error.status === 401) { await identityStore.clear(); return false }
    throw error
  }
  try {
    const signature = await signWithDeviceKey(identity.privateKey, `aelys-device-login-v1\n${identity.deviceId}\n${challenge.nonce}`)
    const session = await deviceRequest<DeviceSessionResponse>('auth/device/login', { challenge_id: challenge.challenge_id, signature })
    if (origin !== sharedOrigin(getApiConfig().baseUrl)) return false
    acceptSession(session, false, true)
    return true
  } catch (error) {
    if (error instanceof SharedApiError && error.status === 401) return false
    throw error
  }
}

/** Explicit "sign in with this device" after a sign-out; a failed attempt keeps the sign-out in force. */
export async function signInWithThisDevice(): Promise<boolean> {
  const wasSignedOut = isSignedOut()
  window.localStorage.removeItem(SIGNED_OUT_KEY)
  const ok = await deviceLogin()
  if (ok) window.dispatchEvent(new Event(SESSION_EVENT))
  else if (wasSignedOut) window.localStorage.setItem(SIGNED_OUT_KEY, '1')
  return ok
}
export function isSignedOut(): boolean { return !!window.localStorage.getItem(SIGNED_OUT_KEY) }
/** Call only after native password authentication has succeeded. */
export function clearNativeSignedOut(): void { window.localStorage.removeItem(SIGNED_OUT_KEY) }

export async function resumeBrowserSession(): Promise<boolean> {
  if (isSignedOut() || !localLaunchAuthenticated()) return false
  if (!refreshFlight) {
    const origin = sharedOrigin(getApiConfig().baseUrl)
    const refresh = async () => {
      try {
        // A browser registered as a device renews its session by signing, not with a stored credential.
        if (await hasDeviceIdentity() && await deviceLogin()) return true
        const session = await browserRequest<BrowserSession>('refresh', {})
        if (isSignedOut() || !localLaunchAuthenticated() || origin !== sharedOrigin(getApiConfig().baseUrl)) return false
        acceptSession(session, false)
        return true
      } catch (error) {
        if (error instanceof SharedApiError && error.status === 401) { clearAccessToken(); return false }
        throw error
      }
    }
    // Serializes rotations across tabs where Web Locks are available.
    refreshFlight = (navigator.locks ? navigator.locks.request('aelys-browser-refresh', refresh) : refresh()).finally(() => { refreshFlight = undefined })
  }
  return refreshFlight
}

async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: 'include' })
  const url = new URL(String(input), window.location.origin)
  if (response.status !== 401 || url.pathname.startsWith('/api/v1/auth/') || isSignedOut()) return response
  const usedToken = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '')
  // An old client must not retry against its previous backend/owner using the
  // newly selected session's credential. Browser auth owns explicit refresh.
  if (!usedToken || url.origin !== new URL(sharedOrigin(getApiConfig().baseUrl), window.location.origin).origin || cacheOwner(usedToken) !== cacheOwner()) return response
  const latest = getAccessToken()
  if (!(latest && latest !== usedToken) && !(await resumeBrowserSession())) return response
  const headers = new Headers(init?.headers)
  const access = getAccessToken()
  if (!access) return response
  headers.set('Authorization', `Bearer ${access}`)
  const retried = await fetch(input, { ...init, headers, credentials: 'include' })
  if (retried.status === 401) clearAccessToken()
  return retried
}

/** Only a namespace hint, never authentication: the server validates the token. */
function cacheOwner(token = getAccessToken()): string | null {
  try {
    const encoded = token?.split('.')[1]
    if (!encoded) return null
    const value: unknown = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')))
    if (value && typeof value === 'object' && 'sub' in value && typeof value.sub === 'string' && value.sub.length > 0 && value.sub.length <= 200) return value.sub
  } catch { /* Invalid tokens must never open a shared private cache. */ }
  return null
}

/** All modules share the owner session. Backend/owner caches are separate even
 * when a user changes servers in Settings. Legacy unscoped caches are not read.
 * Namespace is not authorization; 401/403 still cannot fall back to cached data.
 */
export function getSharedApiClient(): ApiClient {
  const native = isNativeHost()
  const origin = native ? nativeBackendOrigin(getApiConfig().baseUrl) : sharedOrigin(getApiConfig().baseUrl)
  const owner = cacheOwner()
  const partition = JSON.stringify([native ? 'native' : 'browser', origin, owner])
  if (!sharedClient || sharedClientKey !== partition) {
    if (native) {
      let nativeFetchPromise: ReturnType<typeof loadNativeTransport> | undefined
      const nativeFetch: typeof fetch = async (input, init) => {
        nativeFetchPromise ??= loadNativeTransport()
        return createNativeFetch(await nativeFetchPromise, origin)(input, init)
      }
      // ApiClient methods carry the stable `/api/v1` prefix themselves.
      sharedClient = new ApiClient({ baseUrl: origin, fetch: nativeFetch })
      sharedClientKey = partition
      return sharedClient
    }
    let offlineStore: IndexedDbOfflineStore | undefined
    if (owner) {
      try { offlineStore = new IndexedDbOfflineStore(`aelys-shared-v3:${encodeURIComponent(origin)}:${encodeURIComponent(owner)}`) } catch { offlineStore = undefined }
    }
    const partitionToken = () => sharedOrigin(getApiConfig().baseUrl) === origin && cacheOwner() === owner ? getAccessToken() : undefined
    sharedClient = new ApiClient({ baseUrl: origin, getToken: partitionToken, fetch: authenticatedFetch, offlineStore })
    sharedClientKey = partition
  }
  return sharedClient
}

export async function logout(): Promise<void> {
  if (isNativeHost()) {
    const origin = nativeBackendOrigin(getApiConfig().baseUrl)
    try {
      const transport = await loadNativeTransport()
      await transport.logout(origin)
    } catch (error) {
      // Rust reports this only after removing the local credential/session.
      // Propagate it so the caller can explain that server revocation failed.
      if (error === 'LOCAL_LOGOUT_ONLY' || (error instanceof Error && error.message === 'LOCAL_LOGOUT_ONLY')) {
        if (origin === nativeBackendOrigin(getApiConfig().baseUrl)) {
          window.localStorage.setItem(SIGNED_OUT_KEY, '1')
          clearAccessToken()
        }
      }
      throw error
    }
    if (origin === nativeBackendOrigin(getApiConfig().baseUrl)) {
      window.localStorage.setItem(SIGNED_OUT_KEY, '1')
      clearAccessToken()
    }
    return
  }
  const keyBound = await hasDeviceIdentity()
  const token = getAccessToken()
  // Persist intent even when the network is down and the cookie cannot be revoked.
  window.localStorage.setItem(SIGNED_OUT_KEY, '1')
  clearAccessToken()
  if (keyBound) {
    // A key-bound session has no cookie; revoke it with its own bearer. The key stays for the next explicit sign-in.
    if (token) await fetch(`${getApiConfig().baseUrl}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
    return
  }
  await browserRequest('logout', {})
}

export async function login(email: string, password: string): Promise<void> {
  acceptSession(await browserRequest<BrowserSession>('login', { email, password }), true, true)
}

export async function bootstrapOwner(email: string, password: string): Promise<void> {
  acceptSession(await browserRequest<BrowserSession>('bootstrap', { email, password }), true, true)
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function requestJson<T>(path: string, init?: RequestInit, config = getApiConfig()): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 6500)
  const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init?.headers || {}) },
    })
    if (!response.ok) throw new ApiError(`API returned ${response.status}`, response.status)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function checkApi(config = getApiConfig()): Promise<void> {
  const baseUrl = normalizeApiBaseUrl(config.baseUrl)
  const healthUrl = baseUrl === '/api/v1' ? '/healthz' : `${sharedOrigin(baseUrl)}/healthz`
  const response = await fetch(healthUrl, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ApiError(`API returned ${response.status}`, response.status)
  const invalidHealth = new ApiError('API returned an invalid health response', response.status)
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw invalidHealth
  }
  const health: unknown = await response.json().catch(() => { throw invalidHealth })
  if (typeof health !== 'object' || health === null || !('status' in health) || health.status !== 'ok') {
    throw invalidHealth
  }
}

export { API_BASE_STORAGE_KEY, ACCESS_TOKEN_STORAGE_KEY, DEFAULT_API_BASE_URL }
