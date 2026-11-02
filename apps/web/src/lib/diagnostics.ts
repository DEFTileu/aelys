import type { NativeDiagnostic } from './nativeTransport'

type Entry = { id: number; time: string; method: string; path: string; request: Record<string, unknown>; native?: NativeDiagnostic; result?: string; duration?: number }
type Snapshot = { enabled: boolean; entries: readonly Entry[] }
let snapshot: Snapshot = { enabled: false, entries: [] }
let nextId = 0
const listeners = new Set<() => void>()
function publish(next: Snapshot) { snapshot = next; listeners.forEach(listener => listener()) }
export const diagnostics = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot: () => snapshot,
  setEnabled: (enabled: boolean) => publish({ enabled, entries: enabled ? snapshot.entries : [] }),
  clear: () => publish({ ...snapshot, entries: [] }),
  begin(method: string, path: string, body: Record<string, unknown>): number | undefined {
    if (!snapshot.enabled || method !== 'POST' || path !== '/api/v1/ai/runs') return undefined
    const routing = body.routing && typeof body.routing === 'object' ? body.routing as Record<string, unknown> : {}
    // Free text, identifiers, headers, credentials and arbitrary JSON are never recorded.
    const request: Record<string, unknown> = {}
    for (const key of ['conversation_id', 'message', 'idempotency_key', 'tool_scope', 'knowledge']) {
      if (key in body) request[key] = '[скрыто]'
    }
    if ('routing' in body) {
      const safeRouting: Record<string, string> = {}
      for (const key of ['provider', 'provider_id', 'model']) {
        if (key in routing) safeRouting[key] = key === 'provider' && typeof routing[key] === 'string' && /^(claude|openrouter)$/.test(routing[key]) ? routing[key] : '[скрыто]'
      }
      request.routing = safeRouting
    }
    const id = ++nextId
    publish({ ...snapshot, entries: [{ id, time: new Date().toLocaleTimeString(), method, path, request }, ...snapshot.entries].slice(0, 50) })
    return id
  },
  update(id: number | undefined, change: Partial<Pick<Entry, 'native' | 'result' | 'duration'>>) {
    if (id === undefined || !snapshot.enabled) return
    publish({ ...snapshot, entries: snapshot.entries.map(entry => entry.id === id ? { ...entry, ...change } : entry) })
  },
}
