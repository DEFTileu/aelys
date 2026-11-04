import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { AgentSession, ProjectResponse } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { Lock, Square, Terminal } from '../icons'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { readerPlatform } from '../lib/localSessionReader'
import './connected.css'
import './tools.css'
import './developer/developer-mobile.css'

const LocalSessionReader = lazy(() => import('./module/DeveloperHub').then(module => ({ default: module.DeveloperHub })))

const stamp = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No activity yet'
const clockOf = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--'
function span(session: AgentSession): string {
  if (!session.started_at) return '—'
  const end = session.state === 'active' ? Date.now() : session.last_activity_at ? new Date(session.last_activity_at).getTime() : NaN
  const seconds = Math.floor((end - new Date(session.started_at).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 60)}m`
}

const NETWORK = { blocked: 'Blocked', allowlist: 'Allowlist', open: 'Open' } as const
const stopError = (error: unknown) => error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not stop the session. Check your connection.'

export function DeveloperView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [sessions, setSessions] = useState<readonly AgentSession[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [blocked, setBlocked] = useState(false)
  const [selected, setSelected] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopNotice, setStopNotice] = useState('')
  const [readerOpen, setReaderOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      setSessions(await client.agentSessions()); setBlocked(false); setStatus('ready')
      void client.projects().then(setProjects, () => undefined)
    } catch (error) {
      setBlocked(error instanceof ApiError && (error.status === 403 || /POLICY|FORBIDDEN|PERMISSION/.test(error.code)))
      setStatus(navigator.onLine ? 'error' : 'offline')
    }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])

  const activeCount = sessions.filter((session) => session.state === 'active').length
  const visible = showAll ? sessions : sessions.filter((session) => session.state === 'active')
  const current = visible.find((session) => session.id === selected) ?? visible[0]
  // Prefer the path the Mac reports; the linked project name is only a fallback label.
  const where = (session: AgentSession) => session.workspace_path || (projects.find((project) => project.id === session.project_id)?.name ?? 'No linked project')
  const log = current?.events ?? []
  const stop = async (session: AgentSession) => {
    if (stopping) return
    setStopping(true); setStopNotice('')
    try { await getSharedApiClient().stopAgentSession(session.id, { queueOnOffline: false }); setStopNotice('Stop requested.'); await load() }
    catch (error) { setStopNotice(stopError(error)) }
    finally { setStopping(false) }
  }

  const mobile = useIsMobile()

  return <div className={`tl connected-workspace${mobile ? ' dev-m' : ''}`}>
    <div className="tl-bar"><div className="tl-seg" role="tablist" aria-label="Session filter">
      <button type="button" role="tab" aria-selected={!showAll} onClick={() => setShowAll(false)}>Active · {activeCount}</button>
      <button type="button" role="tab" aria-selected={showAll} onClick={() => setShowAll(true)}>All</button></div></div>
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading sessions' : blocked ? 'Access restricted' : status === 'offline' ? 'You are offline' : 'Could not load sessions'}
      description={status === 'loading' ? 'Loading session metadata from the API.' : blocked ? 'The request was denied. Check the owner session and applicable permissions.' : 'Check the connection and try again.'} />
      : !visible.length ? <StateCard status="empty" title={showAll || !sessions.length ? 'No sessions found' : 'No active sessions'} description="Session metadata appears here when your Mac reports it." />
      : <div className="tl-dev">
        <div className="tl-sessions" role="listbox" aria-label="Agent sessions">{visible.map((session) => <button key={session.id} type="button" role="option" aria-selected={session.id === current?.id} className="tl-session" onClick={() => setSelected(session.id)}>
          <span className="tl-session__icon"><Terminal size={18} aria-hidden="true" /></span>
          <span className="tl-session__body"><span className="tl-row" style={{ gap: 8 }}><strong style={{ flex: 1 }}>{session.adapter}</strong><span className={`tl-pill${session.state === 'active' ? ' tl-pill--active' : ''}`}><i />{session.state}</span></span>
            <span className="tl-session__path tl-mono" style={{ display: 'block' }}>{where(session)}</span>
            <span className="tl-muted" style={{ display: 'block', marginTop: 2 }}>{stamp(session.last_activity_at)}</span></span></button>)}</div>
        {current && <section className="tl-detail" aria-label="Session detail">
          <div className="tl-detail__head"><h2>{current.adapter}</h2><div className="tl-mono tl-muted" style={{ fontSize: 13 }}>{where(current)}</div></div>
          <div className="tl-facts">
            <div><span className="tl-muted">Sandbox</span><b>{current.sandbox || 'Not reported'}</b></div>
            <div><span className="tl-muted">Network</span><b>{current.network ? NETWORK[current.network] ?? current.network : 'Not reported'}</b></div>
            <div><span className="tl-muted">{current.state === 'active' ? 'Running for' : 'Ran for'}</span><b>{span(current)}</b></div>
          </div>
          <div className="tl-log tl-mono" aria-label="Event log">{log.length ? log.map((line, index) => <div key={index}><span>{clockOf(line.at)}</span><span>{line.kind}</span><span>{line.message}</span></div>) : <div><span>No events reported yet.</span></div>}</div>
          {stopNotice && <p className="tl-note" role="status">{stopNotice}</p>}
          <div className="tl-foot"><Lock size={14} aria-hidden="true" />Full transcript is stored on this Mac only.<span style={{ flex: 1 }} />
            <button type="button" className="tl-icon-btn" style={{ width: 'auto', height: 36, borderRadius: 12, padding: '0 12px', gap: 6 }} disabled={current.state !== 'active' || stopping || apiStatus !== 'ready'} onClick={() => void stop(current)}><Square size={14} aria-hidden="true" />Stop</button></div>
        </section>}
      </div>}
    {import.meta.env.DEV && readerPlatform() === 'macos' && <section className="tl-detail" aria-label="Local session reader">
      <button type="button" aria-expanded={readerOpen} onClick={() => setReaderOpen(open => !open)}>
        {readerOpen ? 'Hide debug local reader' : 'Open debug local reader'}
      </button>
      {readerOpen && <Suspense fallback={<p role="status">Loading local reader…</p>}><LocalSessionReader apiStatus={apiStatus} localOnly /></Suspense>}
    </section>}
  </div>
}
