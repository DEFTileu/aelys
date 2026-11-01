import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { getDraftPartition } from './api'

export function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('aelys-private-drafts-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readDrafts<T>(key: string): Promise<T | undefined> {
  const db = await openDraftDatabase()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get(key)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}

export async function writeDrafts(key: string, value: unknown): Promise<void> {
  const db = await openDraftDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { db.close() }
}

export class DraftConflict extends Error {}

/** Merge changed entries atomically; never silently replace another tab's draft. */
export async function writeDraftPatch(key: string, previous: Record<string, unknown>, next: Record<string, unknown>): Promise<void> {
  const db = await openDraftDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      const store = transaction.objectStore('drafts')
      const request = store.get(key)
      let conflict = false
      request.onsuccess = () => {
        const current = (request.result ?? {}) as Record<string, unknown>
        for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
          const before = JSON.stringify(previous[field]), after = JSON.stringify(next[field])
          if (before === after) continue
          const stored = JSON.stringify(current[field])
          if (stored !== before && stored !== after) { conflict = true; transaction.abort(); return }
          if (field in next) current[field] = next[field]
          else delete current[field]
        }
        store.put(current, key)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(conflict ? new DraftConflict('Another tab changed this draft') : transaction.error)
    })
  } finally { db.close() }
}

/** Namespace is resolved from authenticated identity, never a shared guest slot. */
export function useDurableDrafts<T extends Record<string, unknown>>(kind: string): {
  drafts: T; setDrafts: Dispatch<SetStateAction<T>>; status: string; ready: boolean
} {
  const [drafts, setDrafts] = useState<T>({} as T)
  const [key, setKey] = useState<string>()
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('Opening local drafts…')
  const writes = useRef(Promise.resolve())
  const baseline = useRef<Record<string, unknown>>({})
  useEffect(() => {
    let alive = true
    const open = async () => {
      try {
        const partition = await getDraftPartition(kind)
        const saved = await readDrafts<T>(partition)
        if (!alive) return
        baseline.current = saved ?? {}
        setDrafts(current => ({ ...saved, ...current }))
        setKey(partition); setStatus('Local drafts ready')
      } catch {
        if (alive) setStatus('Local draft storage unavailable. Keep this page open until saved to the server.')
      } finally { if (alive) setReady(true) }
    }
    void open()
    return () => { alive = false }
  }, [kind])
  useEffect(() => {
    if (!key || !ready) return
    let alive = true
    setStatus('Saving draft on this device…')
    const previous = baseline.current
    baseline.current = drafts
    writes.current = writes.current.catch(() => {}).then(() => writeDraftPatch(key, previous, drafts))
    void writes.current.then(() => { if (alive) setStatus('Drafts saved on this device') }, error => {
      if (alive) setStatus(error instanceof DraftConflict ? 'Another tab changed this draft. Keep this page open and save or copy your text before leaving.' : 'Could not save local draft. Keep this page open.')
    })
    return () => { alive = false }
  }, [key, ready, drafts])
  return { drafts, setDrafts, status, ready }
}
