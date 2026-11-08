import { describe, expect, it, vi } from 'vitest'
import { createLocalSessionReader, readerError } from '../lib/localSessionReader'
import type { NativeInvoke } from '../lib/nativeTransport'

const project = '11111111-1111-4111-8111-111111111111'
const grantId = '22222222-2222-4222-8222-222222222222'
const sessionId = '33333333-3333-4333-8333-333333333333'
const grant = { grant_id: grantId, project_id: project, adapter: 'claude_code' as const, persistent: false as const }

describe('local session reader IPC boundary', () => {
  it('projects compressed-file failures and bounded work without native diagnostic text', async () => {
    const page = { entries_visited: 4, work_units: 4, attempted: 4, indexed: 1, rejected: 3,
      oversized: 0, inaccessible: 0, unsupported: 0, event_limit: 0, indexed_events: 1,
      compression_rejected: 1, expanded_limit: 1, representation_conflict: 1, expanded_bytes_charged: 8388708,
      bytes_charged: 500, discovery_state: 'exhausted', budget_exhausted: false }
    const invoke = vi.fn(async () => ({ ...page, diagnostic: '/private/transcript' }))
    const reader = createLocalSessionReader(invoke as NativeInvoke)
    expect(await reader.indexNext(grantId)).toEqual(page)
    invoke.mockResolvedValueOnce({ ...page, expanded_bytes_charged: -1 } as never)
    await expect(reader.indexNext(grantId)).rejects.toMatchObject({ code: 'READER_INVALID_RESPONSE' })
  })
  it('requests only a native picker binding and never supplies a path or backend origin', async () => {
    const invoke = vi.fn(async () => ({ ...grant, path: '/private/not-for-ui' }))
    const reader = createLocalSessionReader(invoke as NativeInvoke)
    expect(await reader.chooseRoot(project, 'claude_code')).toEqual(grant)
    expect(invoke.mock.calls).toEqual([['session_reader_choose_root', { projectId: project, adapter: 'claude_code' }]])
  })
  it('releases one projected metadata page per call without continuing the cursor', async () => {
    const row = { session_index_id: sessionId, project_id: project, adapter: 'claude_code', started_at: null,
      last_activity_at: '2026-11-05T10:00:00Z', state: 'indexed_snapshot', message_count: 2, path: '/private/source', content: 'private transcript' }
    const invoke = vi.fn(async () => ({ sessions: [row], next_after: null }))
    const result = await createLocalSessionReader(invoke as NativeInvoke).list(grant)
    expect(invoke.mock.calls).toEqual([['session_reader_list', { grantId, after: null, limit: 25 }]])
    expect(result.sessions).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(/private|content|path/)
  })
  it('rejects metadata outside the grant project', async () => {
    const invoke = vi.fn(async () => ({ sessions: [{ session_index_id: sessionId, project_id: sessionId }], next_after: null }))
    await expect(createLocalSessionReader(invoke as NativeInvoke).list(grant)).rejects.toMatchObject({ code: 'READER_INVALID_RESPONSE' })
  })
  it('keeps release identity unavailability distinct and never retries', async () => {
    const invoke = vi.fn(async () => { throw 'READER_IDENTITY_UNAVAILABLE' })
    await expect(createLocalSessionReader(invoke as NativeInvoke).status()).rejects.toMatchObject({ code: 'READER_IDENTITY_UNAVAILABLE' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(readerError('READER_IDENTITY_UNAVAILABLE').message).toContain('owner/device security checks')
  })
  it('does not expose arbitrary native error contents', () => {
    expect(readerError(new Error('/private/path transcript')).message).not.toMatch(/private|transcript/)
    expect(readerError('READER_CANCELLED').code).toBe('READER_CANCELLED')
  })
  it('rejects transcript open without invoking even if a stale host could return content', async () => {
    const cursor = { seq: 7, source_revision: 3, query_hash: null, char_offset: 120 }
    const invoke = vi.fn(async () => [{ seq: 7, role: 'assistant', content: 'local excerpt', occurred_at: null,
      content_truncated: true, next_cursor: { ...cursor, char_offset: 132 }, source_ref: '/private/path' }])
    await expect(createLocalSessionReader(invoke as NativeInvoke).open(grant, sessionId, cursor)).rejects.toMatchObject({ code: 'READER_CONTENT_UNAVAILABLE' })
    expect(invoke).not.toHaveBeenCalled()
  })
  it('rejects search without invoking or sending the supplied query', async () => {
    const cursor = { seq: 8, source_revision: 4, query_hash: Array.from({ length: 32 }, (_, index) => index), char_offset: null }
    const invoke = vi.fn(async () => [{ seq: 8, role: 'user', excerpt: 'found phrase', excerpt_truncated: false, next_cursor: cursor }])
    await expect(createLocalSessionReader(invoke as NativeInvoke).search(grant, sessionId, 'exact phrase', null)).rejects.toMatchObject({ code: 'READER_CONTENT_UNAVAILABLE' })
    await expect(createLocalSessionReader(invoke as NativeInvoke).search(grant, sessionId, 'x'.repeat(4097))).rejects.toMatchObject({ code: 'READER_CONTENT_UNAVAILABLE' })
    expect(invoke).not.toHaveBeenCalled()
  })
  it('rejects malformed cursors and responses over native limits', async () => {
    const invoke = vi.fn(async () => [])
    const reader = createLocalSessionReader(invoke as NativeInvoke)
    await expect(reader.open(grant, sessionId)).rejects.toMatchObject({ code: 'READER_CONTENT_UNAVAILABLE' })
    expect(invoke).not.toHaveBeenCalled()
  })
})
