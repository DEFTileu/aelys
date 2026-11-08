import 'fake-indexeddb/auto'
import type { AIRunIn } from '@aelys/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readDrafts, writeDrafts } from '../lib/durableDrafts'
import { clearPendingAiRun, DraftConflict, loadPendingAiRun, reservePendingAiRun } from '../lib/pendingAiRun'

const identity = vi.hoisted(() => ({ owner: '', backend: 'backend-a' }))
const getDraftPartition = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ getDraftPartition }))

function partition(kind = 'pending-ai-run') {
  return JSON.stringify(['https://aelys.test', identity.backend, identity.owner, kind])
}

function body(key = crypto.randomUUID()): AIRunIn {
  return {
    conversation_id: 'conversation-a', message: 'Private prompt: заметки 🔒',
    idempotency_key: key,
    routing: { provider_id: 'provider-a', model: 'model-a', options: { temperature: 0 } },
    knowledge: { note_ids: ['note-a'], project_id: 'project-a' },
    tool_scope: { scopes: ['tasks.read'] },
  }
}

beforeEach(() => {
  identity.owner = crypto.randomUUID()
  identity.backend = 'backend-a'
  getDraftPartition.mockReset().mockImplementation(async (kind: string) => partition(kind))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('loads an empty slot without creating a draft', async () => {
  expect(await loadPendingAiRun()).toBeUndefined()
  expect(await readDrafts(partition())).toBeUndefined()
})

it('does not reserve a run while another tab has a conversation intent', async () => {
  await writeDrafts(partition('pending-ai-conversation'), { pending: { owner: 'other tab' } })
  await expect(reservePendingAiRun(body())).rejects.toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('refuses to write a request into a changed owner or backend partition', async () => {
  const original = partition()
  identity.owner = crypto.randomUUID()
  await expect(reservePendingAiRun(body(), original)).rejects.toThrow('Session changed')
  expect(await readDrafts(original)).toBeUndefined()
  expect(await readDrafts(partition())).toBeUndefined()
})

it('does not delete a matching key in a different owner partition', async () => {
  const original = partition()
  const request = body()
  identity.owner = crypto.randomUUID()
  await reservePendingAiRun(request)
  await expect(clearPendingAiRun(request.idempotency_key, original)).rejects.toThrow('Session changed')
  expect((await loadPendingAiRun())?.body).toEqual(request)
})

it('restores the exact committed body/key and partition after a module reload', async () => {
  const request = body()
  const pending = await reservePendingAiRun(request)
  expect(pending).toEqual({ partition: partition(), body: request })
  expect(await readDrafts(partition())).toEqual({ pending })
  vi.resetModules()
  const reloaded = await import('../lib/pendingAiRun')
  expect(await reloaded.loadPendingAiRun()).toEqual(pending)
})

it('snapshots nested input before asynchronous partition resolution and returns detached reads', async () => {
  const request = body()
  const original = structuredClone(request)
  const saving = reservePendingAiRun(request)
  Object.assign(request, { message: 'Edited while saving' })
  Object.assign(request.routing!, { model: 'changed-model' })
  const saved = await saving
  expect(saved.body).toEqual(original)
  Object.assign(saved.body, { message: 'Edited return value' })
  const loaded = (await loadPendingAiRun())!
  expect(loaded.body).toEqual(original)
  Object.assign(loaded.body.routing!, { model: 'Edited loaded value' })
  expect((await loadPendingAiRun())?.body).toEqual(original)
})

it('permits identical retries but rejects a second body or key without changing the slot', async () => {
  const request = body()
  const pending = await reservePendingAiRun(request)
  expect(await reservePendingAiRun(structuredClone(request))).toEqual(pending)
  await expect(reservePendingAiRun({ ...request, message: 'Different request' })).rejects.toBeInstanceOf(DraftConflict)
  await expect(reservePendingAiRun({ ...request, idempotency_key: crypto.randomUUID() })).rejects.toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiRun()).toEqual(pending)
})

it('gives exactly one of two independent concurrent reservations the slot', async () => {
  const requests = [body(), body()]
  const results = await Promise.allSettled(requests.map(request => reservePendingAiRun(request)))
  const winners = results.filter(result => result.status === 'fulfilled')
  const losers = results.filter(result => result.status === 'rejected')
  expect(winners).toHaveLength(1)
  expect(losers).toHaveLength(1)
  expect(losers[0].reason).toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiRun()).toEqual(winners[0].value)
})

it('allows concurrent identical retries to share the same immutable reservation', async () => {
  const request = body()
  const [first, second] = await Promise.all([
    reservePendingAiRun(request), reservePendingAiRun(structuredClone(request)),
  ])
  expect(first).toEqual(second)
  expect(await loadPendingAiRun()).toEqual(first)
})

it('resolves reserve only after commit, allowing POST to follow a durable write', async () => {
  const events: string[] = []
  const original = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = original.call(this, value, key)
    request.addEventListener('success', () => events.push('put-success'))
    this.transaction.addEventListener('complete', () => events.push('commit'))
    return request
  })
  const post = vi.fn(() => events.push('post'))
  await reservePendingAiRun(body()).then(post)
  expect(events).toEqual(['put-success', 'commit', 'post'])
  expect(post).toHaveBeenCalledOnce()
})

it('rejects a failed reservation transaction and never proceeds to POST', async () => {
  // A genuine IndexedDB constraint failure aborts the transaction, not just a
  // mocked promise rejection. The existing empty draft remains intact.
  await writeDrafts(partition(), {})
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    return this.add(value, key)
  })
  const post = vi.fn()
  await expect(reservePendingAiRun(body()).then(post)).rejects.toMatchObject({ name: 'ConstraintError' })
  expect(post).not.toHaveBeenCalled()
  expect(await readDrafts(partition())).toEqual({})
})

it('does not acknowledge request success when the reservation transaction later aborts', async () => {
  const original = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = original.call(this, value, key)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  const post = vi.fn()
  await expect(reservePendingAiRun(body()).then(post)).rejects.toThrow('Pending AI run transaction aborted')
  expect(post).not.toHaveBeenCalled()
  expect(await readDrafts(partition())).toBeUndefined()
})

it('isolates owners, backends, and other draft kinds even with the same idempotency key', async () => {
  const request = body()
  const firstOwner = identity.owner
  const first = await reservePendingAiRun(request)
  await writeDrafts(partition('notes'), { note: 'An unrelated draft' })
  identity.owner = 'another-owner'
  expect(await loadPendingAiRun()).toBeUndefined()
  expect(await clearPendingAiRun(request.idempotency_key)).toBe(false)
  const otherOwner = await reservePendingAiRun(request)
  identity.owner = firstOwner
  identity.backend = 'backend-b'
  expect(await loadPendingAiRun()).toBeUndefined()
  expect(await clearPendingAiRun(request.idempotency_key)).toBe(false)
  const otherBackend = await reservePendingAiRun(request)
  expect(otherBackend.partition).not.toBe(otherOwner.partition)
  identity.backend = 'backend-a'
  expect(await loadPendingAiRun()).toEqual(first)
  expect(await readDrafts(partition('notes'))).toEqual({ note: 'An unrelated draft' })
})

it('deletes only a matching key, permits a new reservation, and rejects stale cleanup', async () => {
  const first = body()
  await reservePendingAiRun(first)
  expect(await clearPendingAiRun('wrong-key')).toBe(false)
  expect((await loadPendingAiRun())?.body).toEqual(first)
  expect(await clearPendingAiRun(first.idempotency_key)).toBe(true)
  expect(await loadPendingAiRun()).toBeUndefined()
  expect(await readDrafts(partition())).toBeUndefined()
  expect(await clearPendingAiRun(first.idempotency_key)).toBe(false)
  const next = await reservePendingAiRun(body())
  expect(await clearPendingAiRun(first.idempotency_key)).toBe(false)
  expect(await loadPendingAiRun()).toEqual(next)
})

it('allows exactly one concurrent deletion to succeed', async () => {
  const request = body()
  await reservePendingAiRun(request)
  const results = await Promise.all([
    clearPendingAiRun(request.idempotency_key), clearPendingAiRun(request.idempotency_key),
  ])
  expect(results.sort()).toEqual([false, true])
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('acknowledges deletion only after commit', async () => {
  const pending = await reservePendingAiRun(body())
  const events: string[] = []
  const original = IDBObjectStore.prototype.delete
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    const request = original.call(this, key)
    request.addEventListener('success', () => events.push('delete-success'))
    this.transaction.addEventListener('complete', () => events.push('commit'))
    return request
  })
  expect(await clearPendingAiRun(pending.body.idempotency_key).then(removed => {
    events.push('cleared')
    return removed
  })).toBe(true)
  expect(events).toEqual(['delete-success', 'commit', 'cleared'])
})

it('surfaces deletion errors and preserves the pending receipt for recovery', async () => {
  const pending = await reservePendingAiRun(body())
  const original = IDBObjectStore.prototype.delete
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    this.add('Duplicate key', partition())
    return original.call(this, key)
  })
  await expect(clearPendingAiRun(pending.body.idempotency_key)).rejects.toMatchObject({ name: 'ConstraintError' })
  expect(await loadPendingAiRun()).toEqual(pending)
})

it('keeps the receipt when a successful delete request is rolled back', async () => {
  const pending = await reservePendingAiRun(body())
  const original = IDBObjectStore.prototype.delete
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    const request = original.call(this, key)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  await expect(clearPendingAiRun(pending.body.idempotency_key)).rejects.toThrow('Pending AI run transaction aborted')
  expect(await loadPendingAiRun()).toEqual(pending)
})

it('keeps a new reservation when cleanup races it from another connection', async () => {
  const first = await reservePendingAiRun(body())
  await clearPendingAiRun(first.body.idempotency_key)
  const next = body()
  await Promise.all([reservePendingAiRun(next), clearPendingAiRun(first.body.idempotency_key)])
  expect((await loadPendingAiRun())?.body).toEqual(next)
})

it('propagates database-open failures from every operation without changing the receipt', async () => {
  const pending = await reservePendingAiRun(body())
  const error = new DOMException('Storage unavailable', 'SecurityError')
  const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw error })
  await expect(loadPendingAiRun()).rejects.toBe(error)
  await expect(reservePendingAiRun(body())).rejects.toBe(error)
  await expect(clearPendingAiRun(pending.body.idempotency_key)).rejects.toBe(error)
  spy.mockRestore()
  expect(await loadPendingAiRun()).toEqual(pending)
})

it('propagates identity errors without attempting to open a shared guest slot', async () => {
  const error = new Error('Signed out')
  getDraftPartition.mockRejectedValue(error)
  const open = vi.spyOn(indexedDB, 'open')
  await expect(loadPendingAiRun()).rejects.toBe(error)
  await expect(reservePendingAiRun(body())).rejects.toBe(error)
  await expect(clearPendingAiRun('any-key')).rejects.toBe(error)
  expect(open).not.toHaveBeenCalled()
})

it('propagates read failures from loading and both atomic mutations', async () => {
  const pending = await reservePendingAiRun(body())
  const error = new DOMException('Read unavailable', 'UnknownError')
  const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => { throw error })
  await expect(loadPendingAiRun()).rejects.toBe(error)
  await expect(reservePendingAiRun(body())).rejects.toBe(error)
  await expect(clearPendingAiRun(pending.body.idempotency_key)).rejects.toBe(error)
  spy.mockRestore()
  expect(await loadPendingAiRun()).toEqual(pending)
})

it('reports corrupted or misplaced receipts and never deletes them', async () => {
  const malformed = { pending: { partition: 'foreign-partition', body: body() } }
  await writeDrafts(partition(), malformed)
  await expect(loadPendingAiRun()).rejects.toThrow('Invalid pending AI run storage')
  await expect(clearPendingAiRun(malformed.pending.body.idempotency_key)).rejects.toThrow('Invalid pending AI run storage')
  expect(await readDrafts(partition())).toEqual(malformed)
})

it('requires a nonempty idempotency key before persisting', async () => {
  await expect(reservePendingAiRun({ ...body(), idempotency_key: ' ' })).rejects.toThrow('Invalid pending AI run storage')
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('does not log or transmit request contents, including on a conflict', async () => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'] as const
  const spies = logs.map(level => vi.spyOn(console, level).mockImplementation(() => {}))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const pending = await reservePendingAiRun(body())
  await loadPendingAiRun()
  await expect(reservePendingAiRun(body())).rejects.toBeInstanceOf(DraftConflict)
  await clearPendingAiRun(pending.body.idempotency_key)
  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
