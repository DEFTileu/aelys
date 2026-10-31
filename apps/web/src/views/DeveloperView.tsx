import { useCallback, useEffect, useState } from 'react'
import type { AgentSession, ProjectResponse } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { Lock, Terminal } from '../icons'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './connected.css'
import './tools.css'

const stamp = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No activity yet'
const clockOf = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--'
function span(session: AgentSession): string {
  if (!session.started_at) return '—'
  const end = session.state === 'active' ? Date.now() : session.last_activity_at ? new Date(session.last_activity_at).getTime() : NaN
  const seconds = Math.floor((end - new Date(session.started_at).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 60)}m`
}

export function DeveloperView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [sessions, setSessions] = useState<readonly AgentSession[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [blocked, setBlocked] = useState(false)
  const [selected, setSelected] = useState('')
  const [showAll, setShowAll] = useState(false)

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
  // The API never returns a filesystem path or the local session reference, so the project name stands in for the path line.
  const where = (session: AgentSession) => projects.find((project) => project.id === session.project_id)?.name ?? 'No linked project'
  const log = current ? [
    { t: current.started_at, k: 'start', m: `Session started with ${current.adapter}` },
    ...(current.message_count !== null ? [{ t: current.last_activity_at, k: 'msgs', m: `${current.message_count} messages exchanged` }] : []),
    { t: current.last_activity_at, k: 'state', m: current.state },
  ] : []

  return <div className="tl connected-workspace">
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
            <div><span className="tl-muted">Sandbox</span><b>Not reported</b></div>
            <div><span className="tl-muted">Network</span><b>Not reported</b></div>
            <div><span className="tl-muted">{current.state === 'active' ? 'Running for' : 'Ran for'}</span><b>{span(current)}</b></div>
          </div>
          <div className="tl-log tl-mono" aria-label="Event log">{log.map((line, index) => <div key={index}><span>{clockOf(line.t)}</span><span>{line.k}</span><span>{line.m}</span></div>)}</div>
          <div className="tl-foot"><Lock size={14} aria-hidden="true" />Full transcript is stored on this Mac only.</div>
        </section>}
      </div>}
  </div>
}
