import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDraftDatabase, readDrafts, writeDrafts } from '../lib/durableDrafts'
import {
  clearPendingAiConversation, DraftConflict, loadPendingAiConversation,
  promotePendingAiConversation, reservePendingAiConversation,
  type PendingAiConversationIntent,
} from '../lib/pendingAiConversation'
import { clearPendingAiRun, loadPendingAiRun, reservePendingAiRun } from '../lib/pendingAiRun'

const identity = vi.hoisted(() => ({ owner: '', backend: 'backend-a', origin: 'https://aelys.test' }))
const getDraftPartition = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ getDraftPartition }))

function partition(kind = 'pending-ai-conversation'): string {
  return JSON.stringify([identity.origin, identity.backend, identity.owner, kind])
}

function intent(): PendingAiConversationIntent {
  return {
    body: { title: 'Private chat: заметки 🔒', project_id: 'project-a', knowledge: { note_ids: ['note-a'] } },
    idempotencyKey: crypto.randomUUID(),
    run: {
      message: 'Private prompt: заметки 🔒', idempotency_key: crypto.randomUUID(),
      routing: { provider_id: 'provider-a', model: 'model-a', options: { temperature: 0 } },
      knowledge: { project_id: 'project-a', note_ids: ['note-a'] },
      tool_scope: { scopes: ['tasks.read'] },
    },
  }
}

function runBody(value: PendingAiConversationIntent, conversation_id = 'conversation-a') {
  return { ...value.run, conversation_id }
}

beforeEach(() => {
  identity.owner = crypto.randomUUID()
  identity.backend = 'backend-a'
  identity.origin = 'https://aelys.test'
  getDraftPartition.mockReset().mockImplementation(async (kind: string) => partition(kind))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('loads an empty slot without creating or clearing any records', async () => {
  expect(await loadPendingAiConversation()).toBeUndefined()
  expect(await readDrafts(partition())).toBeUndefined()
})

it('durably restores the exact body, both keys and future run after module reload', async () => {
  const input = intent()
  const pending = await reservePendingAiConversation(input)
  expect(pending).toEqual({ ...input, partition: partition() })
  expect(await readDrafts(partition())).toEqual({ pending })
  vi.resetModules()
  const reloaded = await import('../lib/pendingAiConversation')
  expect(await reloaded.loadPendingAiConversation()).toEqual(pending)
})

it('snapshots nested input before identity lookup and returns detached reads', async () => {
  const input = intent()
  const original = structuredClone(input)
  const saving = reservePendingAiConversation(input)
  Object.assign(input.body, { title: 'Edited title' })
  Object.assign(input.run.routing!, { model: 'edited-model' })
  const pending = await saving
  expect(pending).toEqual({ ...original, partition: partition() })
  Object.assign(pending.run, { message: 'Edited return' })
  const loaded = (await loadPendingAiConversation())!
  expect(loaded.run).toEqual(original.run)
  Object.assign(loaded.body.knowledge!, { note_ids: [] })
  expect((await loadPendingAiConversation())!.body).toEqual(original.body)
})

it('reserves identical retries including different object insertion order', async () => {
  const input = intent()
  const first = await reservePendingAiConversation(input)
  const retry = { run: { ...input.run, routing: { model: 'model-a', options: { temperature: 0 }, provider_id: 'provider-a' } }, idempotencyKey: input.idempotencyKey, body: input.body }
  expect(await reservePendingAiConversation(retry)).toEqual(first)
})

it('retains uploaded attachment IDs in the pending run until conversation promotion', async () => {
  const input = intent()
  const withAttachment = { ...input, run: { ...input.run, attachment_ids: ['attachment-a'] } }
  const saved = await reservePendingAiConversation(withAttachment)
  const promoted = await promotePendingAiConversation(saved, 'conversation-a')
  expect(promoted.body.attachment_ids).toEqual(['attachment-a'])
})

it.each(['body', 'idempotencyKey', 'message', 'runKey', 'routing', 'knowledge', 'tool_scope'] as const)(
  'rejects a reservation changing %s even when the other key is reused', async field => {
    const input = intent()
    const pending = await reservePendingAiConversation(input)
    const changed = structuredClone(input)
    if (field === 'body') Object.assign(changed.body, { title: 'Different title' })
    else if (field === 'idempotencyKey') Object.assign(changed, { idempotencyKey: 'new-conversation-key' })
    else if (field === 'message') Object.assign(changed.run, { message: 'Different message' })
    else if (field === 'runKey') Object.assign(changed.run, { idempotency_key: 'new-run-key' })
    else Object.assign(changed.run, { [field]: {} })
    await expect(reservePendingAiConversation(changed)).rejects.toBeInstanceOf(DraftConflict)
    expect(await loadPendingAiConversation()).toEqual(pending)
  },
)

it('gives exactly one of two distinct concurrent reservations the slot across connections', async () => {
  const results = await Promise.allSettled([reservePendingAiConversation(intent()), reservePendingAiConversation(intent())])
  const winners = results.filter(result => result.status === 'fulfilled')
  const losers = results.filter(result => result.status === 'rejected')
  expect(winners).toHaveLength(1)
  expect(losers).toHaveLength(1)
  expect(losers[0].reason).toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiConversation()).toEqual(winners[0].value)
})

it('shares one immutable reservation between concurrent identical retries', async () => {
  const input = intent()
  const results = await Promise.all([reservePendingAiConversation(input), reservePendingAiConversation(structuredClone(input))])
  expect(results[0]).toEqual(results[1])
})

it('promotes in one readwrite transaction into the exact existing pending run format', async () => {
  const saved = await reservePendingAiConversation(intent())
  await writeDrafts(partition('notes'), { note: 'Keep other drafts' })
  const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
  const promoted = await promotePendingAiConversation(saved, 'conversation-a')
  expect(transaction).toHaveBeenCalledExactlyOnceWith('drafts', 'readwrite')
  transaction.mockRestore()
  expect(promoted).toEqual({ partition: partition('pending-ai-run'), body: runBody(saved) })
  expect(await readDrafts(partition('pending-ai-run'))).toEqual({ pending: promoted })
  expect(await loadPendingAiRun()).toEqual(promoted)
  expect(await loadPendingAiConversation()).toBeUndefined()
  expect(await readDrafts(partition('notes'))).toEqual({ note: 'Keep other drafts' })
})

it('snapshots expected intent before asynchronous promotion and cleanup', async () => {
  const saved = await reservePendingAiConversation(intent())
  const original = structuredClone(saved)
  const promoting = promotePendingAiConversation(saved, 'conversation-a')
  Object.assign(saved.run.routing!, { model: 'edited-model' })
  expect((await promoting).body).toEqual(runBody(original))
  await clearPendingAiRun(original.run.idempotency_key)
  const next = await reservePendingAiConversation(intent())
  const clearing = clearPendingAiConversation(next)
  Object.assign(next.body, { title: 'Edited title' })
  expect(await clearing).toBe(true)
})

it('supports concurrent identical promotions and retry after lost commit acknowledgement', async () => {
  const saved = await reservePendingAiConversation(intent())
  const [first, second] = await Promise.all([
    promotePendingAiConversation(saved, 'conversation-a'), promotePendingAiConversation(saved, 'conversation-a'),
  ])
  expect(first).toEqual(second)
  expect(await promotePendingAiConversation(saved, 'conversation-a')).toEqual(first)
  expect(await loadPendingAiRun()).toEqual(first)
})

it('rejects competing conversation IDs and preserves the winning run', async () => {
  const saved = await reservePendingAiConversation(intent())
  const results = await Promise.allSettled([
    promotePendingAiConversation(saved, 'conversation-a'), promotePendingAiConversation(saved, 'conversation-b'),
  ])
  const winners = results.filter(result => result.status === 'fulfilled')
  const losers = results.filter(result => result.status === 'rejected')
  expect(winners).toHaveLength(1)
  expect(losers).toHaveLength(1)
  expect(losers[0].reason).toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiRun()).toEqual(winners[0].value)
})

it.each(['message', 'idempotency_key', 'conversation_id', 'routing', 'knowledge', 'tool_scope'] as const)(
  'never overwrites a pending run with different %s, preserving the intent', async field => {
    const saved = await reservePendingAiConversation(intent())
    const different = { ...runBody(saved), [field]: ['routing', 'knowledge', 'tool_scope'].includes(field) ? {} : 'different' }
    // Seed a preexisting receipt directly: the run module may already prevent
    // new reservations while an intent exists. Promotion must still fail safe
    // for durable records written by older clients or another code path.
    const existing = { partition: partition('pending-ai-run'), body: different }
    await writeDrafts(existing.partition, { pending: existing })
    await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toBeInstanceOf(DraftConflict)
    expect(await loadPendingAiConversation()).toEqual(saved)
    expect(await loadPendingAiRun()).toEqual(existing)
  },
)

it('accepts an identical preexisting run receipt in the existing module format', async () => {
  const saved = await reservePendingAiConversation(intent())
  const existing = { partition: partition('pending-ai-run'), body: runBody(saved) }
  await writeDrafts(existing.partition, { pending: existing })
  expect(await promotePendingAiConversation(saved, 'conversation-a')).toEqual(existing)
  expect(await loadPendingAiConversation()).toBeUndefined()
})

it('blocks reservation while any pending run exists without changing either slot', async () => {
  const input = intent()
  const run = await reservePendingAiRun(runBody(input))
  await expect(reservePendingAiConversation(input)).rejects.toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiConversation()).toBeUndefined()
  expect(await loadPendingAiRun()).toEqual(run)
})

it('serializes promotion against direct run reservation without losing either receipt', async () => {
  const saved = await reservePendingAiConversation(intent())
  const competing = runBody(intent(), 'other-conversation')
  const results = await Promise.allSettled([
    promotePendingAiConversation(saved, 'conversation-a'), reservePendingAiRun(competing),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')[0].reason).toBeInstanceOf(DraftConflict)
  if (results[0].status === 'fulfilled') {
    expect(await loadPendingAiConversation()).toBeUndefined()
    expect((await loadPendingAiRun())?.body).toEqual(runBody(saved))
  } else {
    expect(await loadPendingAiConversation()).toEqual(saved)
    expect((await loadPendingAiRun())?.body).toEqual(competing)
  }
})

it('never creates a run from a missing or stale expected intent', async () => {
  const saved = await reservePendingAiConversation(intent())
  const stale = { ...saved, body: { ...saved.body, title: 'Stale title' } }
  await expect(promotePendingAiConversation(stale, 'conversation-a')).rejects.toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiConversation()).toEqual(saved)
  await clearPendingAiConversation(saved)
  await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('never recreates an already cleared run or consumes a newer intent on stale promotion', async () => {
  const saved = await reservePendingAiConversation(intent())
  const run = await promotePendingAiConversation(saved, 'conversation-a')
  await clearPendingAiRun(run.body.idempotency_key)
  await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toBeInstanceOf(DraftConflict)
  const next = await reservePendingAiConversation(intent())
  await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toBeInstanceOf(DraftConflict)
  expect(await loadPendingAiConversation()).toEqual(next)
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('clears only a full matching intent and never touches an existing run', async () => {
  const saved = await reservePendingAiConversation(intent())
  const existing = { partition: partition('pending-ai-run'), body: runBody(intent()) }
  await writeDrafts(existing.partition, { pending: existing })
  const staleInputs = [
    { ...saved, idempotencyKey: 'stale-key' },
    { ...saved, body: { ...saved.body, title: 'Stale title' } },
    { ...saved, run: { ...saved.run, idempotency_key: 'stale-run-key' } },
    { ...saved, run: { ...saved.run, message: 'Stale message' } },
    { ...saved, run: { ...saved.run, routing: {} } },
  ]
  for (const stale of staleInputs) expect(await clearPendingAiConversation(stale)).toBe(false)
  expect(await loadPendingAiConversation()).toEqual(saved)
  expect(await clearPendingAiConversation(saved)).toBe(true)
  expect(await clearPendingAiConversation(saved)).toBe(false)
  expect(await readDrafts(saved.partition)).toBeUndefined()
  expect(await loadPendingAiRun()).toEqual(existing)
})

it('allows exactly one concurrent explicit deletion to succeed', async () => {
  const saved = await reservePendingAiConversation(intent())
  const results = await Promise.all([clearPendingAiConversation(saved), clearPendingAiConversation(saved)])
  expect(results.sort()).toEqual([false, true])
})

it('keeps a newer reservation when racing stale cleanup', async () => {
  const saved = await reservePendingAiConversation(intent())
  await clearPendingAiConversation(saved)
  const next = intent()
  await Promise.all([reservePendingAiConversation(next), clearPendingAiConversation(saved)])
  expect(await loadPendingAiConversation()).toEqual({ ...next, partition: partition() })
})

it('serializes forget against promotion without a partial transfer', async () => {
  const saved = await reservePendingAiConversation(intent())
  const [cleared, promoted] = await Promise.allSettled([
    clearPendingAiConversation(saved), promotePendingAiConversation(saved, 'conversation-a'),
  ])
  expect(cleared.status).toBe('fulfilled')
  expect(await loadPendingAiConversation()).toBeUndefined()
  if (promoted.status === 'fulfilled') {
    expect(cleared).toMatchObject({ value: false })
    expect(await loadPendingAiRun()).toEqual(promoted.value)
  } else {
    expect(cleared).toMatchObject({ value: true })
    expect(promoted.reason).toBeInstanceOf(DraftConflict)
    expect(await loadPendingAiRun()).toBeUndefined()
  }
})

it.each(['owner', 'backend', 'origin'] as const)('isolates %s and rejects old bindings for every mutation', async field => {
  const saved = await reservePendingAiConversation(intent())
  identity[field] = `changed-${field}`
  expect(await loadPendingAiConversation()).toBeUndefined()
  await expect(reservePendingAiConversation(intent(), saved.partition)).rejects.toThrow('Session changed')
  await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toThrow('Session changed')
  await expect(clearPendingAiConversation(saved)).rejects.toThrow('Session changed')
  expect(await readDrafts(saved.partition)).toEqual({ pending: saved })
  const other = await reservePendingAiConversation({ body: saved.body, run: saved.run, idempotencyKey: saved.idempotencyKey })
  expect(other.partition).not.toBe(saved.partition)
})

it('derives the run slot from the same identity snapshot without a second lookup', async () => {
  const saved = await reservePendingAiConversation(intent())
  getDraftPartition.mockClear()
  getDraftPartition.mockImplementation(async () => {
    const captured = partition()
    identity.backend = 'backend-b'
    return captured
  })
  const run = await promotePendingAiConversation(saved, 'conversation-a')
  expect(getDraftPartition).toHaveBeenCalledExactlyOnceWith('pending-ai-conversation')
  expect(JSON.parse(run.partition).slice(0, 3)).toEqual(JSON.parse(saved.partition).slice(0, 3))
  expect(await readDrafts(partition('pending-ai-run'))).toBeUndefined()
})

it.each([
  '', 'not-json', '[]', JSON.stringify(['origin', 'backend', '', 'pending-ai-conversation']),
  JSON.stringify(['origin', 'backend', 'owner', 'notes']),
  JSON.stringify(['origin', 'backend', 'owner', 'pending-ai-conversation', 'extra']),
  JSON.stringify(['origin', 'backend', 123, 'pending-ai-conversation']),
])('rejects malformed identity partition %j before opening IndexedDB', async malformed => {
  getDraftPartition.mockResolvedValue(malformed)
  const open = vi.spyOn(indexedDB, 'open')
  await expect(loadPendingAiConversation()).rejects.toThrow('Invalid pending AI conversation storage')
  await expect(reservePendingAiConversation(intent())).rejects.toThrow('Invalid pending AI conversation storage')
  expect(open).not.toHaveBeenCalled()
})

it.each(['', ' ', '\n', 'key\r\ninjection'])('rejects invalid keys %j without storing an intent', async key => {
  const input = intent()
  await expect(reservePendingAiConversation({ ...input, idempotencyKey: key })).rejects.toThrow('Invalid pending AI conversation storage')
  await expect(reservePendingAiConversation({ ...input, run: { ...input.run, idempotency_key: key } })).rejects.toThrow('Invalid pending AI conversation storage')
  expect(await readDrafts(partition())).toBeUndefined()
})

it('rejects oversized conversation header keys and invalid conversation IDs', async () => {
  await expect(reservePendingAiConversation({ ...intent(), idempotencyKey: 'x'.repeat(151) })).rejects.toThrow('Invalid pending AI conversation storage')
  const saved = await reservePendingAiConversation(intent())
  for (const id of ['', ' ']) await expect(promotePendingAiConversation(saved, id)).rejects.toThrow('Invalid AI conversation ID')
  expect(await loadPendingAiConversation()).toEqual(saved)
})

it.each([
  { body: null }, { body: { title: 42 } }, { body: { knowledge: { note_ids: [null] } } },
  { run: { message: 'text', idempotency_key: 'run-key', conversation_id: 'premature-id' } },
  { run: { message: 'text', idempotency_key: 'run-key', routing: [] } },
  { body: { api_key: 'not-allowed-in-envelope' } },
])('rejects malformed intent fields without creating storage: %j', async patch => {
  await expect(reservePendingAiConversation({ ...intent(), ...patch } as unknown as PendingAiConversationIntent)).rejects.toThrow('Invalid pending AI conversation storage')
  expect(await loadPendingAiConversation()).toBeUndefined()
})

it('rejects non-JSON future parameters rather than persisting altered request fingerprints', async () => {
  for (const value of [NaN, Infinity, new Date(), new Map(), [undefined]]) {
    const input = intent()
    Object.assign(input.run, { routing: { value } })
    await expect(reservePendingAiConversation(input)).rejects.toThrow('Invalid pending AI conversation storage')
  }
  const input = intent()
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  Object.assign(input.run, { routing: cyclic })
  await expect(reservePendingAiConversation(input)).rejects.toThrow('Invalid pending AI conversation storage')
  expect(await readDrafts(partition())).toBeUndefined()
})

it.each([null, [], { pending: {} }, { pending: { partition: 'foreign-partition' } }, { unexpected: true }])(
  'reports corrupted intent storage without deleting or overwriting it: %j', async corrupted => {
    const expected = { ...intent(), partition: partition() }
    await writeDrafts(partition(), corrupted)
    await expect(loadPendingAiConversation()).rejects.toThrow('Invalid pending AI conversation storage')
    await expect(reservePendingAiConversation(intent())).rejects.toThrow('Invalid pending AI conversation storage')
    await expect(clearPendingAiConversation(expected)).rejects.toThrow('Invalid pending AI conversation storage')
    await expect(promotePendingAiConversation(expected, 'conversation-a')).rejects.toThrow('Invalid pending AI conversation storage')
    expect(await readDrafts(partition())).toEqual(corrupted)
    expect(await readDrafts(partition('pending-ai-run'))).toBeUndefined()
  },
)

it('preserves corrupted or misplaced run receipts and the recoverable intent', async () => {
  const saved = await reservePendingAiConversation(intent())
  for (const corrupted of [null, { pending: { partition: 'foreign', body: runBody(saved) } }, { unknown: 'receipt' }]) {
    await writeDrafts(partition('pending-ai-run'), corrupted)
    await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toThrow('Invalid pending AI run storage')
    expect(await loadPendingAiConversation()).toEqual(saved)
    expect(await readDrafts(partition('pending-ai-run'))).toEqual(corrupted)
  }
})

it('acknowledges reserve, promotion and cleanup only after commit', async () => {
  const events: string[] = []
  const original = IDBDatabase.prototype.transaction
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const transaction = original.apply(this, args)
    transaction.addEventListener('complete', () => events.push('commit'))
    return transaction
  })
  const saved = await reservePendingAiConversation(intent()).then(value => { events.push('reserved'); return value })
  expect(events).toEqual(['commit', 'reserved'])
  events.length = 0
  await promotePendingAiConversation(saved, 'conversation-a').then(() => events.push('promoted'))
  expect(events).toEqual(['commit', 'promoted'])
  await clearPendingAiRun(saved.run.idempotency_key)
  const next = await reservePendingAiConversation(intent())
  events.length = 0
  await clearPendingAiConversation(next).then(() => events.push('cleared'))
  expect(events).toEqual(['commit', 'cleared'])
})

it('rolls back reservation after request success but before commit', async () => {
  const original = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = original.call(this, value, key)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  const post = vi.fn()
  await expect(reservePendingAiConversation(intent()).then(post)).rejects.toThrow('Pending AI conversation transaction aborted')
  expect(post).not.toHaveBeenCalled()
  expect(await readDrafts(partition())).toBeUndefined()
})

it.each(['put', 'delete'] as const)('rolls back both promotion slots when %s request succeeds then aborts', async method => {
  const saved = await reservePendingAiConversation(intent())
  if (method === 'put') {
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key)
      request.addEventListener('success', () => this.transaction.abort())
      return request
    })
  } else {
    const original = IDBObjectStore.prototype.delete
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key)
      request.addEventListener('success', () => this.transaction.abort())
      return request
    })
  }
  const post = vi.fn()
  await expect(promotePendingAiConversation(saved, 'conversation-a').then(post)).rejects.toThrow()
  expect(post).not.toHaveBeenCalled()
  expect(await loadPendingAiConversation()).toEqual(saved)
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('preserves both preexisting slots when promotion deletion fails asynchronously', async () => {
  const saved = await reservePendingAiConversation(intent())
  await writeDrafts(partition('pending-ai-run'), {})
  const original = IDBObjectStore.prototype.delete
  const spy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    this.add('Duplicate key', saved.partition)
    return original.call(this, key)
  })
  await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toMatchObject({ name: 'ConstraintError' })
  spy.mockRestore()
  expect(await loadPendingAiConversation()).toEqual(saved)
  expect(await readDrafts(partition('pending-ai-run'))).toEqual({})
})

it('preserves intent when an explicit delete is rolled back after success', async () => {
  const saved = await reservePendingAiConversation(intent())
  const original = IDBObjectStore.prototype.delete
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    const request = original.call(this, key)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  await expect(clearPendingAiConversation(saved)).rejects.toThrow('Pending AI conversation transaction aborted')
  expect(await loadPendingAiConversation()).toEqual(saved)
})

it.each(['get', 'put', 'delete'] as const)('aborts promotion on synchronous %s errors, preserving the intent', async method => {
  const saved = await reservePendingAiConversation(intent())
  const error = new DOMException('Storage unavailable', 'UnknownError')
  const spy = vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(() => { throw error })
  await expect(promotePendingAiConversation(saved, 'conversation-a')).rejects.toBe(error)
  spy.mockRestore()
  expect(await loadPendingAiConversation()).toEqual(saved)
  expect(await loadPendingAiRun()).toBeUndefined()
})

it('surfaces asynchronous reservation write errors without replacing the empty slot', async () => {
  await writeDrafts(partition(), {})
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    return this.add(value, key)
  })
  await expect(reservePendingAiConversation(intent())).rejects.toMatchObject({ name: 'ConstraintError' })
  expect(await readDrafts(partition())).toEqual({})
})

it('propagates identity and database-open failures from all public operations', async () => {
  const saved = await reservePendingAiConversation(intent())
  const operations = [
    () => loadPendingAiConversation(), () => reservePendingAiConversation(intent()),
    () => promotePendingAiConversation(saved, 'conversation-a'), () => clearPendingAiConversation(saved),
  ]
  const error = new Error('Signed out')
  getDraftPartition.mockRejectedValue(error)
  const open = vi.spyOn(indexedDB, 'open')
  for (const operation of operations) await expect(operation()).rejects.toBe(error)
  expect(open).not.toHaveBeenCalled()
  getDraftPartition.mockImplementation(async (kind: string) => partition(kind))
  const storageError = new DOMException('Storage unavailable', 'SecurityError')
  open.mockImplementation(() => { throw storageError })
  for (const operation of operations) await expect(operation()).rejects.toBe(storageError)
  open.mockRestore()
  expect(await loadPendingAiConversation()).toEqual(saved)
})

it('closes database connections after successful and failed transactions', async () => {
  // Ensure upgrade does not affect the count.
  const db = await openDraftDatabase()
  db.close()
  const close = vi.spyOn(IDBDatabase.prototype, 'close')
  const saved = await reservePendingAiConversation(intent())
  await expect(reservePendingAiConversation(intent())).rejects.toBeInstanceOf(DraftConflict)
  await loadPendingAiConversation()
  await promotePendingAiConversation(saved, 'conversation-a')
  expect(await clearPendingAiConversation(saved)).toBe(false)
  expect(close).toHaveBeenCalledTimes(5)
})

it('does not log, transmit, or automatically expire private request contents', async () => {
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const saved = await reservePendingAiConversation(intent())
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 60 * 60 * 1000)
  expect(await loadPendingAiConversation()).toEqual(saved)
  await expect(reservePendingAiConversation(intent())).rejects.toBeInstanceOf(DraftConflict)
  const run = await promotePendingAiConversation(saved, 'conversation-a')
  expect(await clearPendingAiConversation(saved)).toBe(false)
  expect(await loadPendingAiRun()).toEqual(run)
  for (const log of logs) expect(log).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})
