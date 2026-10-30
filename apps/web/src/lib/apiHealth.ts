import type { ApiConfig, ApiStatus } from '../types'
import { isNativeHost, loadNativeTransport, nativeBackendOrigin } from './nativeTransport'

const FOCUS_FRESH_MS = 30_000
const HEALTH_TIMEOUT_MS = 6_500

// getApiConfig supplies the normalized default; normalize equivalent inputs for flights.
const healthKey = (baseUrl: string) => baseUrl.trim().replace(/\/$/, '')

// Keep the health response contract aligned with checkApi; the controller needs
// an abortable request so a stalled health check cannot hold its flight forever.
async function fetchHealth(config: ApiConfig): Promise<void> {
  if (isNativeHost()) {
    const healthy = await (await loadNativeTransport()).health(nativeBackendOrigin(config.baseUrl))
    if (!healthy) throw new Error('API is not healthy')
    return
  }
  const baseUrl = healthKey(config.baseUrl)
  const origin = baseUrl.replace(/\/api\/v1$/, '') || window.location.origin
  const healthUrl = baseUrl === '/api/v1' ? '/healthz' : `${origin}/healthz`
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(healthUrl, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`API returned ${response.status}`)
    const invalidHealth = new Error('API returned an invalid health response')
    if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw invalidHealth
    const health: unknown = await response.json().catch(() => { throw invalidHealth })
    if (typeof health !== 'object' || health === null || !('status' in health) || health.status !== 'ok') throw invalidHealth
  } finally {
    window.clearTimeout(timeout)
  }
}

type Dependencies = {
  getConfig: () => ApiConfig
  isOnline: () => boolean
  publish: (status: ApiStatus) => void
  check?: (config: ApiConfig) => Promise<void>
  now?: () => number
}

export function createApiHealth({ getConfig, isOnline, publish, check = fetchHealth, now = Date.now }: Dependencies) {
  let active = true
  let generation = 0
  let status: ApiStatus = isOnline() ? 'loading' : 'offline'
  let lastSuccess: { key: string; at: number } | undefined
  let flight: { key: string; generation: number; promise: Promise<void> } | undefined
  const setStatus = (next: ApiStatus) => {
    if (active && next !== status) { status = next; publish(next) }
  }
  const invalidate = () => { generation += 1; flight = undefined; lastSuccess = undefined }

  function offline() {
    invalidate()
    setStatus('offline')
  }

  function refresh(reason: 'focus' | 'force'): Promise<void> {
    if (!active) return Promise.resolve()
    if (!isOnline()) { offline(); return Promise.resolve() }
    const key = healthKey(getConfig().baseUrl)
    if (flight && flight.key !== key) invalidate()
    if (flight) return flight.promise
    if (reason === 'focus' && lastSuccess?.key === key && now() - lastSuccess.at < FOCUS_FRESH_MS) return Promise.resolve()
    const current = ++generation
    // Only the initial check has a loading state. Background checks retain the
    // current status until a real success or failure changes it.
    const promise = Promise.resolve().then(() => check({ baseUrl: key })).then(() => {
      if (!active || current !== generation) return
      if (!isOnline()) { offline(); return }
      lastSuccess = { key, at: now() }
      setStatus('ready')
    }, () => {
      if (!active || current !== generation) return
      lastSuccess = undefined
      setStatus(isOnline() ? 'error' : 'offline')
    }).finally(() => { if (flight?.generation === current) flight = undefined })
    flight = { key, generation: current, promise }
    return promise
  }

  return { refresh, offline, dispose: () => { active = false; invalidate() } }
}
