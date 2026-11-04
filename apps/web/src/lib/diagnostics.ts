import type { NativeDiagnostic } from './nativeTransport'

type Entry = { id: number; time: string; method: string; path: string; request: unknown; native?: NativeDiagnostic; result?: string; duration?: number; response?: unknown; events?: readonly unknown[] }
type Snapshot = { enabled: boolean; entries: readonly Entry[] }
let snapshot: Snapshot = { enabled: false, entries: [] }
let nextId = 0
const listeners = new Set<() => void>()
function publish(next: Snapshot) { snapshot = next; listeners.forEach(listener => listener()) }
// `(^|_)token$` hides access/refresh tokens but keeps usage fields such as token_counts.
const SECRET_KEY = /pass(word|phrase)|secret|api_?key|authorization|cookie|credential|code_verifier|encrypted|private_key|setup_code|(^|_)token$/i
/** Copy for display: credentials are never kept, and large values are cut so 50 entries stay small. */
export function redactForDiagnostics(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}… [+${value.length - 4000}]` : value
  if (!value || typeof value !== 'object') return value
  if (depth > 8) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(item => redactForDiagnostics(item, depth + 1))
    return value.length > 50 ? [...items, `… [+${value.length - 50}]`] : items
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[скрыто]' : redactForDiagnostics(item, depth + 1)]))
}
export const diagnostics = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  getSnapshot: () => snapshot,
  setEnabled: (enabled: boolean) => publish({ enabled, entries: enabled ? snapshot.entries : [] }),
  clear: () => publish({ ...snapshot, entries: [] }),
  begin(method: string, path: string, body: Record<string, unknown>): number | undefined {
    if (!snapshot.enabled) return undefined
    const id = ++nextId
    publish({ ...snapshot, entries: [{ id, time: new Date().toLocaleTimeString(), method, path, request: redactForDiagnostics(body) }, ...snapshot.entries].slice(0, 50) })
    return id
  },
  update(id: number | undefined, change: Partial<Pick<Entry, 'native' | 'result' | 'duration' | 'response'>>) {
    if (id === undefined || !snapshot.enabled) return
    const safe = 'response' in change ? { ...change, response: redactForDiagnostics(change.response) } : change
    publish({ ...snapshot, entries: snapshot.entries.map(entry => entry.id === id ? { ...entry, ...safe } : entry) })
  },
  event(id: number | undefined, name: string, data: unknown) {
    if (id === undefined || !snapshot.enabled) return
    publish({ ...snapshot, entries: snapshot.entries.map(entry => entry.id === id ? { ...entry, events: [...(entry.events ?? []), { event: name, data: redactForDiagnostics(data) }].slice(-500) } : entry) })
  },
}
