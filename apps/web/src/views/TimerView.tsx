import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusIn, FocusOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './connected.css'

const clock = (seconds: number) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
const errorText = (error: unknown) => error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : 'Focus is unavailable. Check your session and connection.'

export function TimerView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [sessions, setSessions] = useState<readonly FocusOut[]>([])
  const [tasks, setTasks] = useState<readonly TaskOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [taskId, setTaskId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [mode, setMode] = useState('pomodoro')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [now, setNow] = useState(Date.now)
  const pendingStart = useRef<{ key: string; body: FocusIn } | null>(null)
  const active = sessions.find((session) => session.status === 'active')
  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const values = await client.focusSessions()
      setSessions(values); setStatus('ready'); setNow(Date.now())
      const [loadedTasks, loadedProjects] = await Promise.allSettled([client.tasks(), client.projects()])
      if (loadedTasks.status === 'fulfilled') setTasks(loadedTasks.value)
      if (loadedProjects.status === 'fulfilled') setProjects(loadedProjects.value)
    } catch (error) { setNotice(errorText(error)); setStatus(navigator.onLine ? 'error' : 'offline') }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  const elapsed = active ? Math.max(0, Math.floor((now - new Date(active.started_at).getTime()) / 1000)) : 0
  const total = sessions.reduce((sum, session) => sum + (session.id === active?.id ? elapsed : session.elapsed_seconds), 0)
  const start = async () => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      pendingStart.current ??= { key: crypto.randomUUID(), body: { started_at: new Date().toISOString(), task_id: taskId || null, project_id: projectId || null, mode } }
      await getSharedApiClient().startFocusSession(pendingStart.current.body, { queueOnOffline: false, idempotencyKey: pendingStart.current.key })
      pendingStart.current = null
      await load()
    } catch (error) { setNotice(errorText(error)); await load() }
    finally { setBusy(false) }
  }
  const stop = async () => {
    if (!active || busy) return
    setBusy(true); setNotice('')
    try { await getSharedApiClient().stopFocusSession(active.id, { queueOnOffline: false, query: { version: active.version } }); await load() }
    catch (error) { setNotice(errorText(error)) }
    finally { setBusy(false) }
  }
  return <div className="connected-workspace">
    <div className="connected-toolbar"><ApiStatusPill status={apiStatus}/><button className="button button--quiet" onClick={() => void load()}>Refresh</button></div>
    {apiStatus !== 'ready' && <p role="status">Cached focus history is available when previously loaded. Starting and stopping require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {notice && <p role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading focus sessions' : 'Focus sessions unavailable'} description="Check your connection and owner session."/> : <>
      <section className="connected-card timer-card">
        <div className="timer-time" aria-label="Elapsed focus time">{clock(elapsed)}</div>
        <p>{active ? `Started ${new Date(active.started_at).toLocaleString()}` : 'No active focus session'}</p>
        {active ? <button className="button button--primary" disabled={busy || apiStatus !== 'ready'} onClick={() => void stop()}>Stop focus</button> : <>
          <label>Mode<select value={mode} disabled={!!pendingStart.current} onChange={(event) => setMode(event.target.value)}><option value="pomodoro">Pomodoro</option><option value="stopwatch">Stopwatch</option><option value="custom">Custom</option></select></label>
          <label>Task<select value={taskId} disabled={!!pendingStart.current} onChange={(event) => setTaskId(event.target.value)}><option value="">No task</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
          <label>Project<select value={projectId} disabled={!!pendingStart.current} onChange={(event) => setProjectId(event.target.value)}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <button className="button button--primary" disabled={busy || apiStatus !== 'ready'} onClick={() => void start()}>Start focus</button>
        </>}
      </section>
      <section className="connected-card"><h2>Focus history</h2><p>Total focus: {clock(total)} · {sessions.filter((session) => session.status === 'completed').length} completed sessions</p>
        {sessions.length ? sessions.map((session) => <article className="finance-row" key={session.id}><strong>{session.status} · {clock(session.id === active?.id ? elapsed : session.elapsed_seconds)}</strong><span>{new Date(session.started_at).toLocaleString()} · {session.mode}{session.task_id && ` · ${tasks.find((task) => task.id === session.task_id)?.title ?? 'Linked task'}`}{session.project_id && ` · ${projects.find((project) => project.id === session.project_id)?.name ?? 'Linked project'}`}</span></article>) : <StateCard status="empty" title="No focus sessions" description="Start a session to save focus statistics."/>}
      </section>
    </>}
  </div>
}
