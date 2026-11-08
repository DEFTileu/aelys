import type { AIRunIn } from '@aelys/shared'
import { getDraftPartition } from './api'
import { DraftConflict, openDraftDatabase, readDrafts } from './durableDrafts'

export { DraftConflict } from './durableDrafts'

/** Phase 4 / task 2: one local creation receipt per owner/backend, not an outbox.
 * No OPEN product decisions are changed; network/UI integration is separate.
 */
export interface PendingAiRun {
  readonly partition: string
  readonly body: AIRunIn
}

const kind = 'pending-ai-run'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pendingFromDraft(value: unknown, partition: string): PendingAiRun | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Invalid pending AI run storage')
  // An empty draft envelope also represents an unoccupied slot.
  if (!('pending' in value)) return undefined
  const pending = value.pending
  if (!isRecord(pending) || pending.partition !== partition || !isRecord(pending.body)
    || typeof pending.body.conversation_id !== 'string' || !pending.body.conversation_id
    || typeof pending.body.message !== 'string'
    || typeof pending.body.idempotency_key !== 'string' || !pending.body.idempotency_key.trim()) {
    throw new Error('Invalid pending AI run storage')
  }
  return pending as unknown as PendingAiRun
}

/** IDB serializes readwrite transactions across connections/tabs. Keep the
 * comparison and mutation in this one transaction and acknowledge only commit.
 */
async function mutatePending<T>(partition: string, update: (store: IDBObjectStore, pending: PendingAiRun | undefined) => T, conversationPartition?: string): Promise<T> {
  const db = await openDraftDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      const store = transaction.objectStore('drafts')
      const request = store.get(partition)
      let result: T
      let failure: unknown
      transaction.oncomplete = () => resolve(result)
      // Request errors bubble before transaction.error is populated. Preserve
      // their cause, but wait for abort before reporting a rolled-back write.
      transaction.onerror = event => { failure ??= (event.target as IDBRequest).error }
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Pending AI run transaction aborted'))
      request.onsuccess = () => {
        try {
          const current = pendingFromDraft(request.result, partition)
          if (conversationPartition) {
            const other = store.get(conversationPartition)
            other.onsuccess = () => {
              try {
                if (other.result !== undefined && (!isRecord(other.result) || Object.keys(other.result).length > 0)) throw new DraftConflict('Another pending AI conversation occupies this slot')
                result = update(store, current)
              } catch (error) { failure = error; transaction.abort() }
            }
          } else result = update(store, current)
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
    })
  } finally { db.close() }
}

/** Reads the current partition from IndexedDB, including after an offline reload. */
export async function loadPendingAiRun(): Promise<PendingAiRun | undefined> {
  const partition = await getDraftPartition(kind)
  return pendingFromDraft(await readDrafts<unknown>(partition), partition)
}

/** Await this commit BEFORE POST. Reuse this exact body and key on every retry.
 * Atomic CAS permits an identical reservation, but never overwrites another body
 * (even when its idempotency key matches). Storage errors/conflicts propagate.
 */
export async function reservePendingAiRun(body: AIRunIn, expectedPartition?: string): Promise<PendingAiRun> {
  // Snapshot before any await so edits during identity/storage lookup cannot
  // change the request paired with this key.
  const snapshot = structuredClone(body)
  const partition = await getDraftPartition(kind)
  if (expectedPartition !== undefined && partition !== expectedPartition) throw new Error('Session changed')
  const pending = { partition, body: snapshot }
  pendingFromDraft({ pending }, partition)
  const parts: unknown = JSON.parse(partition)
  if (!Array.isArray(parts) || parts.length !== 4 || parts[3] !== kind) throw new Error('Invalid pending AI run partition')
  const conversationPartition = JSON.stringify([...parts.slice(0, 3), 'pending-ai-conversation'])
  return mutatePending(partition, (store, current) => {
    if (current) {
      if (JSON.stringify(current.body) !== JSON.stringify(snapshot)) throw new DraftConflict('Another pending AI run occupies this slot')
      return current
    }
    store.put({ pending }, partition)
    return pending
  }, conversationPartition)
}

/** Atomically removes only the matching key in the current owner/backend slot.
 * false means absent/stale; storage or identity failures reject the promise.
 */
export async function clearPendingAiRun(idempotencyKey: string, expectedPartition?: string): Promise<boolean> {
  const partition = await getDraftPartition(kind)
  if (expectedPartition !== undefined && partition !== expectedPartition) throw new Error('Session changed')
  return mutatePending(partition, (store, pending) => {
    if (pending?.body.idempotency_key !== idempotencyKey) return false
    store.delete(partition)
    return true
  })
}
