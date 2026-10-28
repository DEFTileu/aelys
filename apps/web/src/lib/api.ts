import type { ApiConfig } from '../types'
import { ApiClient, IndexedDbOfflineStore } from '@aelys/shared'

const API_BASE_STORAGE_KEY = 'aelys.apiBaseUrl'
const ACCESS_TOKEN_STORAGE_KEY = 'aelys.accessToken'
const DEFAULT_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

export function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return DEFAULT_API_BASE_URL
  return trimmed.replace(/\/$/, '')
}

export function getApiConfig(): ApiConfig {
  if (typeof window === 'undefined') return { baseUrl: DEFAULT_API_BASE_URL }
  return { baseUrl: normalizeApiBaseUrl(window.localStorage.getItem(API_BASE_STORAGE_KEY) || DEFAULT_API_BASE_URL) }
}

export function saveApiBaseUrl(value: string): ApiConfig {
  const baseUrl = normalizeApiBaseUrl(value)
  window.localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl)
  return { baseUrl }
}

function sharedOrigin(baseUrl: string): string {
  const normalized = normalizeApiBaseUrl(baseUrl)
  if (normalized === '/api/v1') return window.location.origin
  return normalized.replace(/\/api\/v1$/, '') || window.location.origin
}

let sharedClient: ApiClient | undefined
let sharedClientKey = ''

/** Shared typed transport used by web, desktop and mobile shells. */
export function getSharedApiClient(): ApiClient {
  const config = getApiConfig()
  const token = window.sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || undefined
  const key = `${sharedOrigin(config.baseUrl)}:${token || ''}`
  if (!sharedClient || sharedClientKey !== key) {
    let offlineStore: IndexedDbOfflineStore | undefined
    try { offlineStore = new IndexedDbOfflineStore() } catch { offlineStore = undefined }
    sharedClient = new ApiClient({ baseUrl: sharedOrigin(config.baseUrl), token, offlineStore })
    sharedClientKey = key
  }
  return sharedClient
}

export function getAccessToken(): string | undefined {
  return window.sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || undefined
}

export function clearAccessToken(): void {
  window.sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
  sharedClient = undefined
  sharedClientKey = ''
}

export async function login(email: string, password: string): Promise<void> {
  const client = getSharedApiClient()
  const response = await client.login({ email, password })
  client.setToken(response.access_token)
  const enrollment = await client.enrollDevice({ platform: 'web', display_name: 'Aelys Web' })
  window.sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, enrollment.access_token)
  sharedClient = undefined
  sharedClientKey = ''
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
  await getSharedApiClient().syncStatus()
}

export { API_BASE_STORAGE_KEY, ACCESS_TOKEN_STORAGE_KEY, DEFAULT_API_BASE_URL }
