import { consumeSse } from './sse'

/** Window event whose `detail` lists the collections that changed elsewhere; views refetch the ones they show. */
export const CHANGES_EVENT = 'aelys:changes'
export const ALL_COLLECTIONS: readonly string[] = ['tasks', 'events', 'notifications', 'focus']
export const FALLBACK_POLL_MS = 30_000
const MAX_RETRY_MS = 30_000

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = window.setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve() }, { once: true })
})

/** Keeps the owner's hint stream open and reports each hint; while it is down, a 30 s poll stands in for it. */
export function startChangeHints(open: (signal: AbortSignal) => Promise<Response>, onHint: (collections: readonly string[]) => void, canPoll: () => boolean = () => true): () => void {
  const abort = new AbortController()
  let live = false
  const poll = window.setInterval(() => { if (!live && canPoll()) onHint(ALL_COLLECTIONS) }, FALLBACK_POLL_MS)
  void (async () => {
    let failures = 0
    while (!abort.signal.aborted) {
      const opened = Date.now()
      try {
        const response = await open(abort.signal)
        live = true
        if (failures) onHint(ALL_COLLECTIONS)  // hints sent while the stream was down are gone; catch up once
        failures = 0
        await consumeSse(response, (name, data) => {
          if (name === 'changes.hint' && Array.isArray(data.collections)) onHint(data.collections.filter((value): value is string => typeof value === 'string'))
        })
      } catch { failures += 1 }
      live = false
      // The server ends every stream after a few minutes: reopen at once, but never spin on a stream that ends
      // straight away, and back off on errors.
      await wait(failures ? Math.min(MAX_RETRY_MS, 1000 * 2 ** failures) : Date.now() - opened < 10_000 ? 1000 : 0, abort.signal)
    }
  })()
  return () => { abort.abort(); window.clearInterval(poll) }
}

/** Runs `refetch` whenever a hint names one of `collections`; returns the unsubscribe for a useEffect. */
export function onChangeHint(collections: readonly string[], refetch: () => void): () => void {
  const listener = (event: Event) => {
    const changed = (event as CustomEvent<readonly string[]>).detail
    if (Array.isArray(changed) && changed.some((name) => collections.includes(name))) refetch()
  }
  window.addEventListener(CHANGES_EVENT, listener)
  return () => window.removeEventListener(CHANGES_EVENT, listener)
}
