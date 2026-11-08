import type { AIRunIn, ConversationIn } from '@aelys/shared'
import { getDraftPartition } from './api'
import { DraftConflict, openDraftDatabase } from './durableDrafts'
import type { PendingAiRun } from './pendingAiRun'

export { DraftConflict } from './durableDrafts'

/** Phase 4 / task 2: local creation receipts only. Network/UI integration is
 * separate; no OPEN product decisions, retention or automatic replay change.
 */
export type PendingAiConversationRun = Omit<AIRunIn, 'conversation_id'>

export interface PendingAiConversationIntent {
  readonly body: ConversationIn
  /** The conversation POST's Idempotency-Key header. Never regenerated here. */
  readonly idempotencyKey: string
  /** Immutable future run body, including its independent idempotency_key. */
  readonly run: PendingAiConversationRun
}

export interface PendingAiConversation extends PendingAiConversationIntent {
  readonly partition: string
}

const kind = 'pending-ai-conversation'
const runKind = 'pending-ai-run'
const invalid = () => new Error('Invalid pending AI conversation storage')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validKey(value: unknown): value is string {
  return nonempty(value) && !/[\r\n\0]/.test(value)
}

/** Sorted JSON compares objects independently of insertion order. Optional
 * undefined object fields follow JSON omission; other non-JSON values fail.
 */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value)
  if (typeof value !== 'object' || ancestors.has(value)) throw invalid()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item, ancestors)).join(',')}]`
    if (!isRecord(value)) throw invalid()
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`).join(',')}}`
  } finally { ancestors.delete(value) }
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid()
}

function knowledge(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value)) throw invalid()
  fields(value, ['project_id', 'note_ids'])
  if (value.project_id !== undefined && value.project_id !== null && !nonempty(value.project_id)) throw invalid()
  if (value.note_ids !== undefined && (!Array.isArray(value.note_ids) || !value.note_ids.every(nonempty))) throw invalid()
}

function validateIntent(value: unknown, partition: string): asserts value is PendingAiConversation {
  if (!isRecord(value) || !nonempty(value.partition) || value.partition !== partition || !isRecord(value.body) || !isRecord(value.run)
    || !validKey(value.idempotencyKey) || value.idempotencyKey.length > 150
    || !validKey(value.run.idempotency_key) || typeof value.run.message !== 'string') throw invalid()
  fields(value, ['partition', 'body', 'idempotencyKey', 'run'])
  fields(value.body, ['title', 'project_id', 'knowledge', 'tool_scope'])
  fields(value.run, ['message', 'idempotency_key', 'routing', 'knowledge', 'tool_scope', 'attachment_ids'])
  if (value.body.title !== undefined && typeof value.body.title !== 'string') throw invalid()
  if (value.body.project_id !== undefined && value.body.project_id !== null && !nonempty(value.body.project_id)) throw invalid()
  knowledge(value.body.knowledge)
  knowledge(value.run.knowledge)
  for (const object of [value.body.tool_scope, value.run.routing, value.run.tool_scope]) {
    if (object !== undefined && !isRecord(object)) throw invalid()
  }
  if (value.run.attachment_ids !== undefined
    && (!Array.isArray(value.run.attachment_ids) || !value.run.attachment_ids.every(nonempty))) throw invalid()
  canonical(value)
}

function intentFromDraft(value: unknown, partition: string): PendingAiConversation | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid()
  if (Object.keys(value).length === 0) return undefined
  fields(value, ['pending'])
  validateIntent(value.pending, partition)
  return value.pending
}

function runFromDraft(value: unknown, partition: string): PendingAiRun | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Invalid pending AI run storage')
  if (Object.keys(value).length === 0) return undefined
  const pending = value.pending
  if (!isRecord(pending) || pending.partition !== partition || !isRecord(pending.body)
    || !nonempty(pending.body.conversation_id) || typeof pending.body.message !== 'string'
    || !validKey(pending.body.idempotency_key)) throw new Error('Invalid pending AI run storage')
  canonical(pending.body)
  return pending as unknown as PendingAiRun
}

/** Resolve identity once; derive both slots from precisely the same binding. */
async function partitions(expectedPartition?: string): Promise<{ intent: string; run: string }> {
  const intent = await getDraftPartition(kind)
  let parts: unknown
  try { parts = JSON.parse(intent) } catch { throw invalid() }
  if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(nonempty)
    || parts[3] !== kind || JSON.stringify(parts) !== intent) throw invalid()
  if (expectedPartition !== undefined && intent !== expectedPartition) throw new Error('Session changed')
  return { intent, run: JSON.stringify([...parts.slice(0, 3), runKind]) }
}

/** No await inside IDB callbacks. Errors, including synchronous request errors,
 * abort all changes; results become observable only after transaction commit.
 */
async function transact<T>(mode: IDBTransactionMode, operation: (
  store: IDBObjectStore,
  read: (key: string, consume: (value: unknown) => void) => void,
  done: (value: T) => void,
) => void): Promise<T> {
  const db = await openDraftDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('drafts', mode)
      let result: T
      let failure: unknown
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = event => { failure ??= (event.target as IDBRequest).error }
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Pending AI conversation transaction aborted'))
      const guard = (action: () => void) => {
        try { action() } catch (error) { failure = error; transaction.abort() }
      }
      guard(() => {
        const store = transaction.objectStore('drafts')
        operation(store, (key, consume) => {
          const request = store.get(key)
          request.onsuccess = () => guard(() => consume(request.result))
        }, value => { result = value })
      })
    })
  } finally { db.close() }
}

/** Reads the current owner's/backend's intent offline. Never clears storage. */
export async function loadPendingAiConversation(): Promise<PendingAiConversation | undefined> {
  const slots = await partitions()
  return transact('readonly', (_store, read, done) => {
    read(slots.intent, value => done(intentFromDraft(value, slots.intent)))
  })
}

/** Explicit forget only: atomically delete the full matching intent, never a
 * newer reservation or the run receipt. false means absent or stale.
 */
export async function clearPendingAiConversation(expected: PendingAiConversation): Promise<boolean> {
  const snapshot = structuredClone(expected)
  validateIntent(snapshot, snapshot.partition)
  const slots = await partitions(snapshot.partition)
  return transact('readwrite', (store, read, done) => {
    read(slots.intent, value => {
      const current = intentFromDraft(value, slots.intent)
      if (!current || canonical(current) !== canonical(snapshot)) { done(false); return }
      store.delete(slots.intent)
      done(true)
    })
  })
}

/** Await commit BEFORE POST conversation; retry the exact saved body/header key.
 * An identical reservation is allowed; another intent or any pending run blocks
 * a new reservation. Snapshot nested input before asynchronous identity lookup.
 */
export async function reservePendingAiConversation(
  intent: PendingAiConversationIntent,
  expectedPartition?: string,
): Promise<PendingAiConversation> {
  const snapshot = structuredClone(intent)
  const slots = await partitions(expectedPartition)
  const pending = { ...snapshot, partition: slots.intent }
  validateIntent(pending, slots.intent)
  return transact('readwrite', (store, read, done) => {
    read(slots.intent, value => {
      const current = intentFromDraft(value, slots.intent)
      if (current && canonical(current) !== canonical(pending)) throw new DraftConflict('Another pending AI conversation occupies this slot')
      read(slots.run, value => {
        if (runFromDraft(value, slots.run)) throw new DraftConflict('Another pending AI run occupies this slot')
        if (!current) store.put({ pending }, slots.intent)
        done(current ?? pending)
      })
    })
  })
}

/** After POST conversation succeeds, atomically transfer the matching intent to
 * the existing pending-ai-run format. Await this commit BEFORE POST run.
 * Retry after a lost commit acknowledgement is safe only while the exact run
 * receipt remains. Missing/stale intents never recreate a cleared run.
 */
export async function promotePendingAiConversation(
  expected: PendingAiConversation,
  conversationId: string,
): Promise<PendingAiRun> {
  const snapshot = structuredClone(expected)
  if (!nonempty(conversationId)) throw new Error('Invalid AI conversation ID')
  validateIntent(snapshot, snapshot.partition)
  const slots = await partitions(snapshot.partition)
  const pending: PendingAiRun = { partition: slots.run, body: { ...snapshot.run, conversation_id: conversationId } }
  return transact('readwrite', (store, read, done) => {
    read(slots.intent, value => {
      const current = intentFromDraft(value, slots.intent)
      if (current && canonical(current) !== canonical(snapshot)) throw new DraftConflict('Pending AI conversation changed')
      read(slots.run, value => {
        const run = runFromDraft(value, slots.run)
        if (run && canonical(run.body) !== canonical(pending.body)) throw new DraftConflict('Another pending AI run occupies this slot')
        if (!current && !run) throw new DraftConflict('Pending AI conversation is missing')
        if (!run) store.put({ pending }, slots.run)
        if (current) store.delete(slots.intent)
        done(run ?? pending)
      })
    })
  })
}
