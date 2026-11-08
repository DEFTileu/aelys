/** Local-only prototype IPC. Never pass this through HTTP, diagnostics, caches or sync. */
import { isNativeHost, type NativeInvoke } from './nativeTransport'

export type ReaderAdapter = 'claude_code' | 'codex_cli'
export type ReaderGrant = { grant_id: string; project_id: string; adapter: ReaderAdapter; persistent: false }
export type ReaderStatus = {
  available: boolean
  persistent_grants: boolean
  metadata_listing_available: boolean
  native_confirmation_required: boolean
  backend_identity_integrated: boolean
  agent_execution_granted: boolean
  os_isolation_verified: boolean
}
export type IndexPage = {
  entries_visited: number; work_units: number; attempted: number; indexed: number
  rejected: number; oversized: number; inaccessible: number; unsupported: number; event_limit: number; indexed_events: number; bytes_charged: number
  representation_conflict: number; compression_rejected: number; expanded_limit: number; expanded_bytes_charged: number
  discovery_state: 'more' | 'exhausted' | 'exhausted_with_omissions' | 'stopped_with_unattempted_candidates'
  budget_exhausted: boolean
}
export type ReaderSession = {
  session_index_id: string; project_id: string; adapter: ReaderAdapter
  started_at: string | null; last_activity_at: string | null
  state: 'indexed_snapshot'; message_count: number
}
export type ReaderSessionPage = { sessions: ReaderSession[]; next_after: string | null }
export type ReaderCursor = { seq: number; source_revision: number; query_hash: number[] | null; char_offset: number | null }
export type ReaderContentItem = { seq: number; role: string; content: string; occurred_at: string | null; content_truncated: boolean; next_cursor: ReaderCursor | null }
export type ReaderSearchHit = { seq: number; role: string; excerpt: string; excerpt_truncated: boolean; next_cursor: ReaderCursor | null }

const messages = {
  READER_IDENTITY_UNAVAILABLE: 'Local reader is unavailable in this build until packaged owner/device security checks are verified.',
  READER_CANCELLED: 'Cancelled in the native dialog. No new permission was granted.',
  READER_PLATFORM_UNAVAILABLE: 'Local session reading is available only in the macOS desktop app.',
  READER_FORBIDDEN: 'Local reader access is restricted to the approved desktop window.',
  READER_GRANT_REVOKED: 'This temporary grant is no longer active. Select a folder again to create a new grant.',
  READER_ROOT_UNAVAILABLE: 'The selected folder is no longer available. Revoke this grant and select it again.',
  READER_ROOT_TOO_BROAD: 'Select only the agent session storage folder. Your home folder and its ancestors are not allowed.',
  READER_BUDGET_EXHAUSTED: 'The temporary indexing budget was reached. Results are partial; select a folder again for a new pass.',
  READER_PASS_FINISHED: 'This bounded pass has ended. You can still request indexed metadata.',
  READER_BUSY: 'The local reader is busy. Try the action again when it is free.',
  READER_DIALOG_BUSY: 'A native reader dialog is already open. Finish that dialog before trying again.',
  READER_GRANT_LIMIT: 'The local reader has reached its temporary grant limit. Revoke a grant or quit Aelys before trying again.',
  READER_DISCOVERY_FAILED: 'Local discovery failed. The pass may be partial; revoke and select again for a fresh pass.',
  READER_INDEX_FAILED: 'Local indexing failed. The pass may be partial; revoke and select again for a fresh pass.',
  READER_METADATA_FAILED: 'Could not read the local metadata page. Try that page again.',
  READER_INVALID_PROJECT: 'Choose an existing project before selecting a session folder.',
  READER_INVALID_GRANT: 'The local grant could not be validated.',
  READER_INVALID_LIMIT: 'The local metadata page request is invalid.',
  READER_INVALID_QUERY: 'Enter a literal search phrase of 1 to 4096 UTF-8 bytes.',
  READER_CONTENT_UNAVAILABLE: 'Transcript open and local search are disabled until native response delivery is safe.',
  SIGN_IN_REQUIRED: 'Your native session ended. Sign in and select the folder again.',
  READER_PROJECT_UNAVAILABLE: 'This project is no longer available to the current owner. Select a project again.',
  NETWORK_ERROR: 'Could not verify the owner and device. Reconnect and try again.',
  FORBIDDEN: 'The current owner or device cannot access this reader.',
  READER_REGISTRATION_FAILED: 'Could not create the temporary local grant. Try selecting a folder again.',
  READER_STORE_UNAVAILABLE: 'The temporary local index is unavailable.',
  READER_NATIVE_UI_UNAVAILABLE: 'The native permission dialog is unavailable.',
  READER_HOME_UNAVAILABLE: 'The native reader could not verify the folder boundary.',
  READER_SELECTION_UNAVAILABLE: 'The native picker did not return an eligible local folder.',
  READER_UNAVAILABLE: 'The local reader is unavailable. This does not indicate a backend connection failure.',
  READER_INVALID_RESPONSE: 'The local reader returned an unsupported response. No metadata was displayed.',
} as const
export type ReaderErrorCode = keyof typeof messages
export class ReaderError extends Error {
  constructor(readonly code: ReaderErrorCode) { super(messages[code]) }
}
export function readerError(error: unknown): ReaderError {
  if (error instanceof ReaderError) return error
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return new ReaderError(Object.hasOwn(messages, code) ? code as ReaderErrorCode : 'READER_UNAVAILABLE')
}

export function readerPlatform(): 'macos' | 'android' | 'web' | 'unsupported' {
  if (!isNativeHost()) return 'web'
  if (/Android/i.test(navigator.userAgent)) return 'android'
  return /Mac/i.test(navigator.userAgent) ? 'macos' : 'unsupported'
}

function invalid(): never { throw new ReaderError('READER_INVALID_RESPONSE') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) return invalid()
  return value
}
function adapter(value: unknown): ReaderAdapter {
  return value === 'claude_code' || value === 'codex_cli' ? value : invalid()
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
}
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid() }
function timestamp(value: unknown): string | null {
  if (value === null) return null
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : invalid()
}
function cursor(value: unknown): ReaderCursor | null {
  if (value === null) return null
  const row = record(value)
  if (!Object.hasOwn(row, 'seq') || !Object.hasOwn(row, 'source_revision') || !Object.hasOwn(row, 'query_hash') || !Object.hasOwn(row, 'char_offset')) return invalid()
  let queryHash: number[] | null = null
  if (row.query_hash !== null) {
    if (!Array.isArray(row.query_hash) || row.query_hash.length !== 32 || row.query_hash.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) return invalid()
    queryHash = [...row.query_hash] as number[]
  }
  return { seq: count(row.seq), source_revision: count(row.source_revision), query_hash: queryHash,
    char_offset: row.char_offset === null ? null : count(row.char_offset) }
}
function boundedTextPage(value: unknown, field: 'content' | 'excerpt', truncatedField: 'content_truncated' | 'excerpt_truncated'): Array<ReaderContentItem | ReaderSearchHit> {
  if (!Array.isArray(value) || value.length > 25) return invalid()
  let bytes = 0
  return value.map(item => {
    const row = record(item), text = row[field]
    if (typeof text !== 'string' || typeof row.role !== 'string' || row.role.length > 32 || !/^[a-z_]{1,32}$/.test(row.role) || typeof row[truncatedField] !== 'boolean') return invalid()
    bytes += new TextEncoder().encode(text).length
    if (bytes > 16 * 1024) return invalid()
    if (field === 'content') return {
      seq: count(row.seq), role: row.role, content: text, occurred_at: timestamp(row.occurred_at),
      content_truncated: boolean(row.content_truncated), next_cursor: cursor(row.next_cursor),
    }
    return { seq: count(row.seq), role: row.role, excerpt: text, excerpt_truncated: boolean(row.excerpt_truncated), next_cursor: cursor(row.next_cursor) }
  })
}

export function createLocalSessionReader(invoke: NativeInvoke) {
  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    try { return await invoke<unknown>(command, args) } catch (error) { throw readerError(error) }
  }
  return {
    async status(): Promise<ReaderStatus> {
      const value = record(await call('session_reader_status'))
      return {
        available: boolean(value.available), persistent_grants: boolean(value.persistent_grants),
        metadata_listing_available: boolean(value.metadata_listing_available), native_confirmation_required: boolean(value.native_confirmation_required),
        backend_identity_integrated: boolean(value.backend_identity_integrated), agent_execution_granted: boolean(value.agent_execution_granted),
        os_isolation_verified: boolean(value.os_isolation_verified),
      }
    },
    async chooseRoot(projectId: string, kind: ReaderAdapter): Promise<ReaderGrant> {
      const project = uuid(projectId), selectedAdapter = adapter(kind)
      const value = record(await call('session_reader_choose_root', { projectId: project, adapter: selectedAdapter }))
      if (value.persistent !== false || value.project_id !== project || value.adapter !== selectedAdapter) return invalid()
      return { grant_id: uuid(value.grant_id), project_id: project, adapter: selectedAdapter, persistent: false }
    },
    async indexNext(grantId: string): Promise<IndexPage> {
      const value = record(await call('session_reader_index_next', { grantId: uuid(grantId) }))
      const state = value.discovery_state
      if (state !== 'more' && state !== 'exhausted' && state !== 'exhausted_with_omissions' && state !== 'stopped_with_unattempted_candidates') return invalid()
      return {
        entries_visited: count(value.entries_visited), work_units: count(value.work_units), attempted: count(value.attempted),
        indexed: count(value.indexed), rejected: count(value.rejected), oversized: count(value.oversized), inaccessible: count(value.inaccessible), unsupported: count(value.unsupported), event_limit: count(value.event_limit), indexed_events: count(value.indexed_events),
        bytes_charged: count(value.bytes_charged), discovery_state: state, budget_exhausted: boolean(value.budget_exhausted),
        // Older debug hosts predate compressed input and never decode it.
        representation_conflict: count(value.representation_conflict ?? 0),
        compression_rejected: count(value.compression_rejected ?? 0), expanded_limit: count(value.expanded_limit ?? 0),
        expanded_bytes_charged: count(value.expanded_bytes_charged ?? 0),
      }
    },
    async list(grant: ReaderGrant, after: string | null = null): Promise<ReaderSessionPage> {
      const value = record(await call('session_reader_list', { grantId: uuid(grant.grant_id), after: after === null ? null : uuid(after), limit: 25 }))
      if (!Array.isArray(value.sessions) || value.sessions.length > 25) return invalid()
      const sessions = value.sessions.map((item): ReaderSession => {
        const row = record(item)
        if (row.project_id !== grant.project_id || row.adapter !== grant.adapter || row.state !== 'indexed_snapshot') return invalid()
        // Explicit projection: never retain titles, source paths, native IDs or content.
        return { session_index_id: uuid(row.session_index_id), project_id: uuid(row.project_id), adapter: adapter(row.adapter),
          started_at: timestamp(row.started_at), last_activity_at: timestamp(row.last_activity_at), state: 'indexed_snapshot', message_count: count(row.message_count) }
      })
      const next = value.next_after === null ? null : uuid(value.next_after)
      if (next !== null && (sessions.length !== 25 || next !== sessions.at(-1)?.session_index_id || next === after)) return invalid()
      return { sessions, next_after: next }
    },
    async open(grant: ReaderGrant, sessionId: string, after: ReaderCursor | null = null): Promise<ReaderContentItem[]> {
      void grant; void sessionId; void after
      throw new ReaderError('READER_CONTENT_UNAVAILABLE')
    },
    async search(grant: ReaderGrant, sessionId: string, query: string, after: ReaderCursor | null = null): Promise<ReaderSearchHit[]> {
      void grant; void sessionId; void query; void after
      throw new ReaderError('READER_CONTENT_UNAVAILABLE')
    },
    async revoke(grantId: string): Promise<void> { await call('session_reader_revoke', { grantId: uuid(grantId) }) },
  }
}
export type LocalSessionReader = ReturnType<typeof createLocalSessionReader>
export async function loadLocalSessionReader(): Promise<LocalSessionReader> {
  if (readerPlatform() !== 'macos') throw new ReaderError('READER_PLATFORM_UNAVAILABLE')
  const { invoke } = await import('@tauri-apps/api/core')
  return createLocalSessionReader(invoke)
}
