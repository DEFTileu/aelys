import { useContext, useEffect, useRef, useState } from 'react'
import type { ProjectResponse } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { SessionReaderAuthContext } from '../../lib/sessionReaderAuth'
import {
  loadLocalSessionReader, readerError, ReaderError,
  type IndexPage, type LocalSessionReader, type ReaderAdapter, type ReaderContentItem, type ReaderCursor, type ReaderGrant,
  type ReaderSearchHit, type ReaderSessionPage, type ReaderStatus,
} from '../../lib/localSessionReader'

type Busy = 'checking' | 'projects' | 'choosing' | 'indexing' | 'listing' | 'opening' | 'searching' | null
type Progress = { pages: number; indexed: number; rejected: number; oversized: number; inaccessible: number; unsupported: number; eventLimit: number; representationConflict: number; compressionRejected: number; expandedLimit: number; expandedBytes: number; events: number; entries: number; bytes: number; last: IndexPage }

export function useLocalSessionReader() {
  const requireSignIn = useContext(SessionReaderAuthContext)
  const [status, setStatus] = useState<ReaderStatus | null>(null)
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [projectError, setProjectError] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [adapter, setAdapter] = useState<ReaderAdapter>('claude_code')
  const [grant, setGrant] = useState<ReaderGrant | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeFailed, setRevokeFailed] = useState(false)
  const [error, setError] = useState<ReaderError | null>(null)
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [page, setPage] = useState<ReaderSessionPage | null>(null)
  const [pageNumber, setPageNumber] = useState(0)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [contentPage, setContentPage] = useState<ReaderContentItem[] | null>(null)
  const [contentCursor, setContentCursor] = useState<ReaderCursor | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPage, setSearchPage] = useState<ReaderSearchHit[] | null>(null)
  const [searchCursor, setSearchCursor] = useState<ReaderCursor | null>(null)
  const queryValue = useRef('')
  const [indexBlocked, setIndexBlocked] = useState(false)
  const [accessBlocked, setAccessBlocked] = useState(false)
  const reader = useRef<LocalSessionReader | null>(null)
  const currentGrant = useRef<ReaderGrant | null>(null)
  const alive = useRef(true)
  const epoch = useRef(0)
  const lock = useRef(false)
  const revokeLock = useRef(false)

  // Cleanup only revokes access; it never discovers, indexes or releases metadata.
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
      queryValue.current = ''
      const id = currentGrant.current?.grant_id
      currentGrant.current = null
      if (id) void reader.current?.revoke(id).catch(() => { /* Grants also expire on app quit. */ })
    }
  }, [])

  function clearSessionResults() {
    queryValue.current = ''
    setSelectedSessionId(null); setContentPage(null); setContentCursor(null)
    setSearchPage(null); setSearchCursor(null); setSearchQuery('')
  }
  function clearResults() { setPage(null); setPageNumber(0); setProgress(null); clearSessionResults() }
  async function run<T>(kind: Exclude<Busy, null>, action: () => Promise<T>, accept: (value: T) => void, stale?: (value: T) => Promise<void>) {
    if (lock.current || revokeLock.current) return
    lock.current = true
    const ticket = ++epoch.current
    setBusy(kind); setError(null); setNotice('')
    try {
      const value = await action()
      if (alive.current && epoch.current === ticket) accept(value)
      else await stale?.(value)
    } catch (failure) {
      if (!alive.current || epoch.current !== ticket) return
      const safe = readerError(failure)
      setError(safe)
      if (['READER_GRANT_REVOKED', 'SIGN_IN_REQUIRED', 'READER_PROJECT_UNAVAILABLE'].includes(safe.code)) {
        currentGrant.current = null; setGrant(null); clearResults()
        if (safe.code !== 'READER_GRANT_REVOKED') setStatus(null)
      }
      if (['READER_DISCOVERY_FAILED', 'READER_INDEX_FAILED', 'READER_BUDGET_EXHAUSTED', 'READER_PASS_FINISHED', 'READER_INVALID_RESPONSE'].includes(safe.code)) setIndexBlocked(true)
      if (['READER_IDENTITY_UNAVAILABLE', 'READER_ROOT_UNAVAILABLE', 'READER_FORBIDDEN', 'READER_PLATFORM_UNAVAILABLE', 'SIGN_IN_REQUIRED', 'READER_PROJECT_UNAVAILABLE', 'NETWORK_ERROR', 'FORBIDDEN'].includes(safe.code)) {
        setAccessBlocked(true); setPage(null); setPageNumber(0); clearSessionResults()
      }
      // Only the current action may expire the enclosing authenticated view.
      // Late failures after revoke/unmount must not close a replacement login.
      if (safe.code === 'SIGN_IN_REQUIRED') requireSignIn?.()
    } finally {
      if (epoch.current === ticket) { lock.current = false; if (alive.current) setBusy(null) }
    }
  }

  async function projectChoices() {
    try { return await getSharedApiClient().projects() } catch { return null }
  }
  function acceptProjects(value: readonly ProjectResponse[] | null) {
    setProjectError(value === null)
    if (value === null) return
    setProjects(value)
    setProjectId(previous => value.some(project => project.id === previous) ? previous : value[0]?.id ?? '')
  }
  function check() {
    void run('checking', async () => {
      const transport = await loadLocalSessionReader()
      reader.current = transport
      const value = await transport.status()
      if (!value.available) throw new ReaderError('READER_UNAVAILABLE')
      if (value.persistent_grants || !value.native_confirmation_required || !value.metadata_listing_available || value.agent_execution_granted) throw new ReaderError('READER_INVALID_RESPONSE')
      return { status: value, projects: await projectChoices() }
    }, value => { setStatus(value.status); setAccessBlocked(false); acceptProjects(value.projects) })
  }
  function reloadProjects() {
    if (currentGrant.current) return
    void run('projects', projectChoices, acceptProjects)
  }
  function choose() {
    if (!reader.current || !status || accessBlocked || currentGrant.current || !projects.some(project => project.id === projectId)) return
    const transport = reader.current
    void run('choosing', () => transport.chooseRoot(projectId, adapter), value => {
      currentGrant.current = value; setGrant(value); clearResults(); setIndexBlocked(false); setRevokeFailed(false)
      setNotice('Temporary local read grant created. Indexing has not started.')
    }, value => transport.revoke(value.grant_id))
  }
  function indexNext() {
    if (!reader.current || !currentGrant.current || accessBlocked || indexBlocked || progress?.last.budget_exhausted || (progress && progress.last.discovery_state !== 'more')) return
    const id = currentGrant.current.grant_id
    // Clear cursors BEFORE indexing: this is a live UUID keyset, not a snapshot.
    // Even cancellation/error never reuses a potentially stale pagination cursor.
    void run('indexing', () => { setPage(null); setPageNumber(0); clearSessionResults(); return reader.current!.indexNext(id) }, value => {
      setProgress(previous => ({ pages: (previous?.pages ?? 0) + 1, indexed: (previous?.indexed ?? 0) + value.indexed,
        rejected: (previous?.rejected ?? 0) + value.rejected, oversized: (previous?.oversized ?? 0) + value.oversized, inaccessible: (previous?.inaccessible ?? 0) + value.inaccessible, unsupported: (previous?.unsupported ?? 0) + value.unsupported, eventLimit: (previous?.eventLimit ?? 0) + value.event_limit, events: (previous?.events ?? 0) + value.indexed_events,
        representationConflict: (previous?.representationConflict ?? 0) + value.representation_conflict,
        compressionRejected: (previous?.compressionRejected ?? 0) + value.compression_rejected, expandedLimit: (previous?.expandedLimit ?? 0) + value.expanded_limit, expandedBytes: (previous?.expandedBytes ?? 0) + value.expanded_bytes_charged,
        entries: (previous?.entries ?? 0) + value.entries_visited, bytes: (previous?.bytes ?? 0) + value.bytes_charged, last: value }))
      setNotice('One index page finished. Further indexing and metadata each need a new approval.')
    })
  }
  function list(next = false) {
    if (!reader.current || !currentGrant.current || accessBlocked || (next && !page?.next_after)) return
    const active = currentGrant.current
    const cursor = next ? page!.next_after : null
    void run('listing', () => reader.current!.list(active, cursor), value => {
      setPage(value); setPageNumber(previous => next ? previous + 1 : 1)
      setNotice(value.sessions.length ? 'One metadata page loaded locally.' : 'No metadata returned on this page.')
    })
  }
  function selectSession(sessionId: string) {
    if (!currentGrant.current || !page?.sessions.some(session => session.session_index_id === sessionId)) return
    clearSessionResults()
    setSelectedSessionId(sessionId)
  }
  function openSession(next = false) {
    const active = currentGrant.current, transport = reader.current, sessionId = selectedSessionId
    if (!active || !transport || !sessionId || accessBlocked || (next && !contentCursor)) return
    const cursor = next ? contentCursor : null
    void run('opening', () => transport.open(active, sessionId, cursor), value => {
      setContentPage(value); setContentCursor(value.at(-1)?.next_cursor ?? null)
      setNotice(value.length ? 'One bounded local content page loaded after native approval.' : 'No more local content on this page.')
    })
  }
  function setQuery(value: string) {
    queryValue.current = value
    setSearchQuery(value); setSearchPage(null); setSearchCursor(null)
  }
  function searchSession(next = false) {
    const active = currentGrant.current, transport = reader.current, sessionId = selectedSessionId
    if (!active || !transport || !sessionId || accessBlocked || (next && !searchCursor)) return
    const cursor = next ? searchCursor : null
    const requestedQuery = searchQuery
    void run('searching', () => transport.search(active, sessionId, requestedQuery, cursor), value => {
      if (queryValue.current !== requestedQuery) return
      setSearchPage(value); setSearchCursor(value.at(-1)?.next_cursor ?? null)
      setNotice(value.length ? 'One bounded literal-search page loaded after native approval.' : 'No literal matches on this page.')
    })
  }
  async function revoke() {
    if (!reader.current || !currentGrant.current || revokeLock.current) return
    const id = currentGrant.current.grant_id
    revokeLock.current = true
    epoch.current++; lock.current = false
    setBusy(null); setRevoking(true); setRevokeFailed(false); setError(null); setNotice(''); clearResults()
    try {
      await reader.current.revoke(id)
      if (!alive.current) return
      currentGrant.current = null; setGrant(null); setAccessBlocked(false); setIndexBlocked(false)
      setNotice('Temporary grant revoked and displayed metadata cleared. Source files are unchanged.')
    } catch (failure) {
      if (alive.current) { setError(readerError(failure)); setRevokeFailed(true); setAccessBlocked(true) }
    } finally {
      revokeLock.current = false
      if (alive.current) setRevoking(false)
    }
  }
  return { status, projects, projectError, projectId, setProjectId, adapter, setAdapter, grant, busy, revoking, revokeFailed,
    error, notice, progress, page, pageNumber, selectedSessionId, contentPage, contentCursor, searchQuery, searchPage, searchCursor,
    indexBlocked, accessBlocked, check, reloadProjects, choose, indexNext, list, selectSession, openSession, setQuery, searchSession, revoke }
}
