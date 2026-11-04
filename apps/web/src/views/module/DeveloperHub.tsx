import { useEffect, useRef, useState } from 'react'
import type { AgentSession } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { readerPlatform, type ReaderAdapter } from '../../lib/localSessionReader'
import { Terminal, Folder, Shield } from '../../icons'
import type { ApiStatus } from '../../types'
import { useLocalSessionReader } from './useLocalSessionReader'
import './developer-hub.css'

const adapterName = (value: string) => value === 'claude_code' ? 'Claude Code' : value === 'codex_cli' ? 'Codex CLI' : 'Agent'
function date(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not provided'
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
}

// This source never receives local reader data or grants. Only existing backend metadata is requested.
function BackendMetadata({ apiStatus }: { apiStatus: ApiStatus }) {
  const [rows, setRows] = useState<readonly AgentSession[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const lock = useRef(false)
  async function load() {
    if (lock.current || apiStatus !== 'ready') return
    lock.current = true; setBusy(true); setFailed(false)
    try { setRows(await getSharedApiClient().agentSessions()) } catch { setFailed(true) }
    finally { lock.current = false; setBusy(false) }
  }
  useEffect(() => { if (apiStatus === 'ready') void load() }, [apiStatus])
  return <section className="reader-card" aria-labelledby="reader-backend-title">
    <div className="reader-card__head"><h2 id="reader-backend-title">Backend metadata</h2><span className="reader-badge">Separate source · {apiStatus === 'ready' ? 'Connected' : apiStatus === 'loading' ? 'Checking connection' : 'Unavailable'}</span></div>
    <p>Previously synced session metadata from Aelys. Local temporary grants and index results are never uploaded by this reader.</p>
    <p>Showing up to 100 sessions. If 100 are shown, more records may exist.</p>
    <button type="button" onClick={() => void load()} disabled={busy || apiStatus !== 'ready'}>{busy ? 'Loading backend metadata…' : 'Refresh'}</button>
    {apiStatus !== 'ready' && <p>Backend metadata needs a connected owner session. This does not describe local reader availability.</p>}
    <div aria-live="polite" aria-busy={busy}>
      {failed && <p role="alert">Could not load backend metadata. Check the connection and owner permissions.</p>}
      {rows?.length === 0 && <p>No sessions found in backend metadata</p>}
      {!!rows?.length && <ul className="reader-sessions">{rows.map(row => <li key={row.id}><strong>{adapterName(row.adapter)}</strong><span>{row.state}</span><small>Last activity: {date(row.last_activity_at)}</small></li>)}</ul>}
    </div>
  </section>
}

export function DeveloperHub({ apiStatus, localOnly = false }: { apiStatus: ApiStatus; localOnly?: boolean }) {
  const platform = readerPlatform()
  if (localOnly && (!import.meta.env.DEV || platform !== 'macos')) return null
  return <div className={localOnly ? 'developer-hub developer-hub--embedded' : 'developer-hub'}>
    {!localOnly && <header className="reader-heading"><span className="reader-icon"><Terminal size={22} aria-hidden="true" /></span><div><h1>Developer Hub</h1><p>Local session reader · Incomplete prototype</p></div></header>}
    {platform === 'macos' ? <MacSessionReader /> : <section className="reader-card" aria-labelledby="reader-platform-title">
      <h2 id="reader-platform-title">Local reader unavailable {platform === 'android' ? 'on Android' : platform === 'web' ? 'in the browser' : 'on this platform'}</h2>
      <p>Choose and index local agent session storage in the macOS desktop app. Web and Android cannot read this Mac’s files through this prototype.</p>
      <p>Opening transcripts, local session search and remote execution are not available here.</p>
    </section>}
    {!localOnly && <BackendMetadata apiStatus={apiStatus} />}
  </div>
}

function MacSessionReader() {
  const r = useLocalSessionReader()
  const finished = !!r.progress && r.progress.last.discovery_state !== 'more'
  const stopped = finished || r.indexBlocked || r.progress?.last.budget_exhausted
  const locked = !!r.busy || r.revoking
  const localUnavailable = r.accessBlocked && !r.grant
  const passLabel = r.progress?.last.budget_exhausted ? 'Budget reached · Partial pass'
    : r.progress?.last.discovery_state === 'stopped_with_unattempted_candidates' ? 'Stopped · Unattempted files remain'
    : r.progress?.last.discovery_state === 'exhausted_with_omissions' ? 'Walk ended · Some entries omitted'
    : finished ? 'Bounded walk ended' : r.progress ? 'More entries may remain' : 'Not started'
  return <>
    <section className="reader-card reader-boundary" aria-labelledby="reader-boundary-title">
      <div className="reader-card__head"><h2 id="reader-boundary-title"><Shield size={18} aria-hidden="true" />Temporary local reading</h2><span className="reader-badge">macOS only</span></div>
      <p>Local grants are bound to the current native owner and device session. Aelys checks project ownership online before reading and returning metadata. Verified OS isolation and agent execution are not provided.</p>
      <p>Release builds keep the reader unavailable until packaged security and device checks are verified. Local reading requires a separate native approval for each index page and each metadata page.</p>
      {(!r.status || (r.accessBlocked && !r.revokeFailed)) && <button className="reader-primary" type="button" disabled={locked} onClick={r.check}>{r.busy === 'checking' ? 'Checking local reader…' : r.status ? 'Retry local connection' : 'Check local reader'}</button>}
      {r.status && <span className="reader-badge">{r.accessBlocked ? 'Local access unavailable' : 'Local commands available'} · Temporary grants only</span>}
    </section>
    <div className="reader-feedback" aria-live="polite" aria-atomic="true">
      {r.busy && <p role="status">{r.busy === 'checking' ? 'Checking this build and loading existing project labels…' : r.busy === 'projects' ? 'Loading existing project labels…' : r.busy === 'choosing' ? 'Waiting for folder selection in the native picker…' : r.busy === 'indexing' ? 'Waiting for native approval or indexing one bounded page…' : 'Waiting for native approval or loading one metadata page…'}</p>}
      {r.revoking && <p role="status">Revoking local access…</p>}
      {r.error && <p role={r.error.code === 'READER_CANCELLED' ? 'status' : 'alert'}>{r.error.message}{r.revokeFailed ? ' Revocation is not confirmed. Retry revoke or quit Aelys to discard temporary grants.' : ''}</p>}
      {r.notice && <p role="status">{r.notice}</p>}
    </div>
    {r.status && <div className="reader-layout">
      <section className="reader-card reader-controls" aria-labelledby="reader-setup-title" aria-busy={r.busy === 'projects' || r.busy === 'choosing'}>
        <h2 id="reader-setup-title"><Folder size={18} aria-hidden="true" />Choose session storage</h2>
        {!r.grant && <ol className="reader-steps"><li>Choose an existing project and adapter</li><li>Allow temporary reading in the native folder picker</li><li>Approve one page at a time, then revoke</li></ol>}
        <label htmlFor="reader-project">Existing project</label>
        <select id="reader-project" disabled={locked || !!r.grant || localUnavailable} value={r.projectId} onChange={event => r.setProjectId(event.target.value)}>
          {!r.projects.length && <option value="">No projects loaded</option>}
          {r.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
        {r.projectError && <p role="alert">Could not load project labels from Aelys or its local cache. Local reader availability is separate.</p>}
        {!r.projects.length && !r.projectError && <p>Create a project in Projects first, then reload these labels.</p>}
        {!r.grant && <button type="button" disabled={locked || localUnavailable} onClick={r.reloadProjects}>{r.busy === 'projects' ? 'Loading projects…' : 'Reload projects'}</button>}
        <label htmlFor="reader-adapter">Session adapter</label>
        <select id="reader-adapter" disabled={locked || !!r.grant || localUnavailable} value={r.adapter} onChange={event => r.setAdapter(event.target.value as ReaderAdapter)}><option value="claude_code">Claude Code</option><option value="codex_cli">Codex CLI</option></select>
        <p className="reader-caption">Select only the adapter’s session storage folder. The path stays in native code and is never returned to this UI.</p>
        {!r.grant ? <button className="reader-primary" type="button" onClick={r.choose} disabled={locked || !r.projectId || localUnavailable}>{r.busy === 'choosing' ? 'Waiting for native picker…' : 'Choose folder & allow temporarily'}</button>
          : <><span className="reader-badge">{r.revokeFailed ? 'Revocation unconfirmed' : 'Temporary grant'} · {adapterName(r.grant.adapter)}</span><p>Held only for this app process. Revoke before changing project, adapter or folder.</p><button className="reader-revoke" type="button" onClick={() => void r.revoke()} disabled={r.revoking}>{r.revoking ? 'Revoking…' : r.revokeFailed ? 'Retry revoke' : 'Revoke local grant'}</button></>}
      </section>
      <div className="reader-results">
        <section className="reader-card" aria-labelledby="reader-index-title" aria-busy={r.busy === 'indexing'}>
          <div className="reader-card__head"><h2 id="reader-index-title">Index progress</h2><span className="reader-badge">{passLabel}</span></div>
          <p>Each approval processes one bounded page. No background scan or automatic continuation.</p>
          {r.progress && <><dl className="reader-facts"><div><dt>Pages</dt><dd>{r.progress.pages}</dd></div><div><dt>Indexed files</dt><dd>{r.progress.indexed}</dd></div><div><dt>Rejected files</dt><dd>{r.progress.rejected}</dd></div><div><dt>Indexed events</dt><dd>{r.progress.events}</dd></div><div><dt>Entries visited</dt><dd>{r.progress.entries}</dd></div><div><dt>Bytes charged</dt><dd>{r.progress.bytes.toLocaleString('en')}</dd></div></dl>
            {r.progress.oversized > 0 && <p>Skipped over the 4 MiB local size limit: {r.progress.oversized}</p>}
            <p>Codex .jsonl.zst: 4 MiB compressed / 4 MiB expanded per file; decoder window ≤ 4 MiB. One frame only; no dictionaries.</p>
            {r.progress.representationConflict > 0 && <p>Compressed files skipped because a plain sibling exists or its absence could not be verified: {r.progress.representationConflict}. The compressed copy was not used.</p>}
            {r.progress.compressionRejected > 0 && <p>Compressed files rejected (malformed, truncated, extra frames, dictionary or window limit): {r.progress.compressionRejected}</p>}
            {r.progress.expandedLimit > 0 && <p>Compressed files exceeding the 4 MiB expanded limit: {r.progress.expandedLimit}</p>}
            {r.progress.expandedBytes > 0 && <p>Expanded bytes charged: {r.progress.expandedBytes.toLocaleString('en')}</p>}
            {r.progress.inaccessible > 0 && <p>Unavailable within the selected boundary: {r.progress.inaccessible}</p>}
            {r.progress.unsupported > 0 && <p>Empty or unsupported session files: {r.progress.unsupported}</p>}
            {r.progress.eventLimit > 0 && <p>Sessions exceeding the 10,000-event limit: {r.progress.eventLimit}</p>}
            <p className="reader-caption">{stopped ? 'The pass ended or stopped at a limit. It does not prove a complete filesystem snapshot or current source availability.' : 'Progress is cumulative for approved pages; the total is unknown.'}{r.progress.rejected > 0 ? ' Rejected files were not updated. A previously indexed snapshot may still be shown and may be out of date.' : ''}</p></>}
          <button className="reader-primary" type="button" disabled={!r.grant || locked || r.accessBlocked || !!stopped} onClick={r.indexNext}>{r.busy === 'indexing' ? 'Waiting / indexing one page…' : 'Index next page · Approve once'}</button>
          {stopped && <p>You can request available metadata. Revoke and select again to start a new pass.</p>}
        </section>
        <section className="reader-card" aria-labelledby="reader-metadata-title" aria-busy={r.busy === 'listing'}>
          <div className="reader-card__head"><h2 id="reader-metadata-title">Local indexed metadata</h2><span className="reader-badge">On this Mac · 25 per page</span></div>
          <p>Snapshots contain adapter, timestamps and message counts only. Transcript open and local search are unavailable while the reader delivery race is unresolved.</p>
          <div className="reader-actions"><button type="button" disabled={!r.grant || locked || r.accessBlocked} onClick={() => r.list()}>{r.busy === 'listing' ? 'Waiting / loading one page…' : r.page ? 'Restart metadata · Approve once' : 'Show metadata · Approve once'}</button>
            {r.page?.next_after && <button type="button" disabled={locked || r.accessBlocked} onClick={() => r.list(true)}>Next metadata page · Approve once</button>}</div>
          {r.page && <><p className="reader-caption">Page {r.pageNumber} · {r.page.sessions.length} records{r.page.next_after ? ' · More may remain (the next page may be empty)' : ' · End of current listing'}</p>
            {r.page.sessions.length ? <ul className="reader-sessions">{r.page.sessions.map(session => <li key={session.session_index_id}><div><strong>{adapterName(session.adapter)}</strong><span className="reader-badge">Indexed snapshot</span></div><dl><div><dt>Started</dt><dd>{date(session.started_at)}</dd></div><div><dt>Last activity</dt><dd>{date(session.last_activity_at)}</dd></div><div><dt>Messages</dt><dd>{session.message_count}</dd></div></dl><button type="button" aria-pressed={r.selectedSessionId === session.session_index_id} disabled={locked || r.accessBlocked} onClick={() => r.selectSession(session.session_index_id)}>{r.selectedSessionId === session.session_index_id ? 'Selected for local reading' : 'Select for local reading'}</button></li>)}</ul> : <p>No indexed metadata on this page. Index a page first if you have not started.</p>}</>}
          <p className="reader-caption">Indexing resets this listing and cursor. New snapshots may appear before a previous cursor.</p>
        </section>
        {r.selectedSessionId && <section className="reader-card" aria-labelledby="reader-content-title">
          <h2 id="reader-content-title">Transcript open and search unavailable</h2>
          <p>Desktop commands are disabled until a safe revoke-versus-delivery design resolves the response race. No transcript content or search terms are sent from this UI.</p>
        </section>}
      </div>
    </div>}
    <footer className="reader-footer">This metadata reader does not send paths or local results to diagnostics. Transcript open and local search remain disabled pending resolution of a native response-delivery race.</footer>
  </>
}
