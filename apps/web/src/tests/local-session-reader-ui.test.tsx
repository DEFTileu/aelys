import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeveloperHub } from '../views/module/DeveloperHub'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), projects: vi.fn(), sessions: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => ({ projects: mocks.projects, agentSessions: mocks.sessions }) }))

let root: Root | undefined
const originalAgent = navigator.userAgent
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalAgent })
  vi.resetAllMocks()
})
async function mount(native = true) {
  if (native) Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<DeveloperHub apiStatus="ready" />))
  return host
}
async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
describe('local reader gestures and availability', () => {
  it('does not invoke on mount and explains the release identity gate without a connection error', async () => {
    mocks.invoke.mockRejectedValue('READER_IDENTITY_UNAVAILABLE')
    const host = await mount()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await click(host, 'Check local reader')
    expect(mocks.invoke.mock.calls).toEqual([['session_reader_status', undefined]])
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('owner/device security checks')
    expect(host.textContent).not.toContain('Could not load backend metadata')
    expect(host.textContent).not.toContain('Choose folder & allow temporarily')
    expect(mocks.projects).not.toHaveBeenCalled()
    expect(mocks.sessions).toHaveBeenCalledTimes(1) // Existing backend metadata is loaded separately.
  })
  it('keeps the browser local reader unavailable and backend metadata separate', async () => {
    const host = await mount(false)
    expect(host.textContent).toContain('Local reader unavailable in the browser')
    expect(host.textContent).toContain('Backend metadata')
    expect(host.textContent).toContain('Showing up to 100 sessions. If 100 are shown, more records may exist.')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('never automatically indexes or lists after selecting a temporary grant', async () => {
    const project = '11111111-1111-4111-8111-111111111111'
    mocks.projects.mockResolvedValue([{ id: project, name: 'Existing project' }])
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'session_reader_status') return { available: true, persistent_grants: false, metadata_listing_available: true,
        native_confirmation_required: true, backend_identity_integrated: false, agent_execution_granted: false, os_isolation_verified: false }
      if (command === 'session_reader_choose_root') return { grant_id: '22222222-2222-4222-8222-222222222222', project_id: project, adapter: 'claude_code', persistent: false }
      if (command === 'session_reader_revoke') return
      throw new Error('Unexpected command')
    })
    const host = await mount()
    await click(host, 'Check local reader')
    await click(host, 'Choose folder & allow temporarily')
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['session_reader_status', 'session_reader_choose_root'])
    expect(host.textContent).toContain('Indexing has not started')
    await click(host, 'Revoke local grant')
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['session_reader_status', 'session_reader_choose_root', 'session_reader_revoke'])
    expect(host.textContent).toContain('Temporary grant revoked')
  })
  it('discards late metadata when the temporary grant is revoked', async () => {
    const project = '11111111-1111-4111-8111-111111111111'
    const grant = '22222222-2222-4222-8222-222222222222'
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    mocks.projects.mockResolvedValue([{ id: project, name: 'Existing project' }])
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'session_reader_status') return { available: true, persistent_grants: false, metadata_listing_available: true, native_confirmation_required: true, backend_identity_integrated: false, agent_execution_granted: false, os_isolation_verified: false }
      if (command === 'session_reader_choose_root') return { grant_id: grant, project_id: project, adapter: 'claude_code', persistent: false }
      if (command === 'session_reader_list') return pending
      if (command === 'session_reader_revoke') return
      throw new Error('Unexpected command')
    })
    const host = await mount()
    await click(host, 'Check local reader')
    await click(host, 'Choose folder & allow temporarily')
    await click(host, 'Show metadata · Approve once')
    await click(host, 'Revoke local grant')
    await act(async () => finish({ sessions: [{ session_index_id: '33333333-3333-4333-8333-333333333333', project_id: project, adapter: 'claude_code', started_at: null, last_activity_at: null, state: 'indexed_snapshot', message_count: 42 }], next_after: null }))
    expect(host.textContent).toContain('Temporary grant revoked')
    expect(host.textContent).not.toContain('42')
  })
  it('does not expose transcript open or local search while native delivery is disabled', async () => {
    const project = '11111111-1111-4111-8111-111111111111'
    const grant = '22222222-2222-4222-8222-222222222222'
    const session = '33333333-3333-4333-8333-333333333333'
    mocks.projects.mockResolvedValue([{ id: project, name: 'Existing project' }])
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'session_reader_status') return { available: true, persistent_grants: false, metadata_listing_available: true, native_confirmation_required: true, backend_identity_integrated: false, agent_execution_granted: false, os_isolation_verified: false }
      if (command === 'session_reader_choose_root') return { grant_id: grant, project_id: project, adapter: 'claude_code', persistent: false }
      if (command === 'session_reader_list') return { sessions: [{ session_index_id: session, project_id: project, adapter: 'claude_code', started_at: null, last_activity_at: null, state: 'indexed_snapshot', message_count: 1 }], next_after: null }
      if (command === 'session_reader_open') return [{ seq: 1, role: 'assistant', content: 'local only', occurred_at: null, content_truncated: false, next_cursor: null }]
      if (command === 'session_reader_search') return [{ seq: 1, role: 'assistant', excerpt: 'literal hit', excerpt_truncated: false, next_cursor: null }]
      return
    })
    const host = await mount()
    await click(host, 'Check local reader')
    await click(host, 'Choose folder & allow temporarily')
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['session_reader_status', 'session_reader_choose_root'])
    await click(host, 'Show metadata · Approve once')
    await click(host, 'Select for local reading')
    expect(mocks.invoke.mock.calls.map(call => call[0])).not.toContain('session_reader_open')
    expect(host.textContent).toContain('Transcript open and search unavailable')
    expect(host.querySelector('#reader-search-query')).toBeNull()
    expect([...host.querySelectorAll('button')].some(button => /Open session|Search ·|Next content|Next search/.test(button.textContent ?? ''))).toBe(false)
    expect(mocks.invoke.mock.calls.map(call => call[0])).not.toContain('session_reader_open')
    expect(mocks.invoke.mock.calls.map(call => call[0])).not.toContain('session_reader_search')
  })
  it('allows another indexing page when the reader reports more work', async () => {
    const project = '11111111-1111-4111-8111-111111111111'
    const grant = '22222222-2222-4222-8222-222222222222'
    mocks.projects.mockResolvedValue([{ id: project, name: 'Existing project' }])
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'session_reader_status') return { available: true, persistent_grants: false, metadata_listing_available: true, native_confirmation_required: true, backend_identity_integrated: true, agent_execution_granted: false, os_isolation_verified: false }
      if (command === 'session_reader_choose_root') return { grant_id: grant, project_id: project, adapter: 'claude_code', persistent: false }
      if (command === 'session_reader_index_next') return { entries_visited: 2, work_units: 2, attempted: 1, indexed: 1, rejected: 0, oversized: 1, inaccessible: 1, unsupported: 1, event_limit: 1, compression_rejected: 1, expanded_limit: 1, representation_conflict: 1, expanded_bytes_charged: 100, indexed_events: 10000, bytes_charged: 100, discovery_state: 'more', budget_exhausted: false }
      return
    })
    const host = await mount()
    await click(host, 'Check local reader')
    await click(host, 'Choose folder & allow temporarily')
    await click(host, 'Index next page · Approve once')
    expect(host.textContent).toContain('Skipped over the 4 MiB local size limit: 1')
    expect(host.textContent).toContain('Unavailable within the selected boundary: 1')
    expect(host.textContent).toContain('Empty or unsupported session files: 1')
    expect(host.textContent).toContain('Sessions exceeding the 10,000-event limit: 1')
    expect(host.textContent).toContain('Compressed files rejected (malformed, truncated, extra frames, dictionary or window limit): 1')
    expect(host.textContent).toContain('Compressed files exceeding the 4 MiB expanded limit: 1')
    expect(host.textContent).toContain('a plain sibling exists or its absence could not be verified: 1')
    expect(host.textContent).toContain('Expanded bytes charged: 100')
    const next = [...host.querySelectorAll('button')].find(button => button.textContent === 'Index next page · Approve once')!
    expect(next.disabled).toBe(false)
    await click(host, 'Index next page · Approve once')
    expect(mocks.invoke.mock.calls.filter(call => call[0] === 'session_reader_index_next')).toHaveLength(2)
  })
  it('warns that rejected files may still have older indexed snapshots', async () => {
    const project = '11111111-1111-4111-8111-111111111111'
    const grant = '22222222-2222-4222-8222-222222222222'
    mocks.projects.mockResolvedValue([{ id: project, name: 'Existing project' }])
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'session_reader_status') return { available: true, persistent_grants: false, metadata_listing_available: true, native_confirmation_required: true, backend_identity_integrated: true, agent_execution_granted: false, os_isolation_verified: false }
      if (command === 'session_reader_choose_root') return { grant_id: grant, project_id: project, adapter: 'claude_code', persistent: false }
      if (command === 'session_reader_index_next') return { entries_visited: 1, work_units: 2, attempted: 1, indexed: 0, rejected: 1, oversized: 0, inaccessible: 0, unsupported: 1, event_limit: 0, indexed_events: 0, bytes_charged: 8, discovery_state: 'exhausted', budget_exhausted: false }
      return
    })
    const host = await mount()
    await click(host, 'Check local reader')
    await click(host, 'Choose folder & allow temporarily')
    expect(host.textContent).not.toContain('A previously indexed snapshot may still be shown')
    await click(host, 'Index next page · Approve once')
    expect(host.textContent).toContain('Rejected files were not updated. A previously indexed snapshot may still be shown and may be out of date.')
    expect(host.textContent).not.toContain('Rejected files were not indexed.')
  })
})
