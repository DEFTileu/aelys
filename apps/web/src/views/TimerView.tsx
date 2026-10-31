import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusIn, FocusOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { Play, RotateCcw, Square, SquareCheck } from '../icons'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './connected.css'
import './tools.css'

type Mode = 'focus' | 'break' | 'stopwatch'
const MODES: readonly { id: Mode; label: string }[] = [{ id: 'focus', label: 'Focus' }, { id: 'break', label: 'Break' }, { id: 'stopwatch', label: 'Stopwatch' }]
const PRESETS: Record<Mode, readonly number[]> = { focus: [25, 50, 90], break: [5, 10, 15], stopwatch: [] }
// The API has no break or pause concept: breaks are a local countdown that is never saved.
const API_MODE: Record<'focus' | 'stopwatch', string> = { focus: 'pomodoro', stopwatch: 'stopwatch' }

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (seconds: number) => seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
const duration = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 60)}m`
const errorText = (error: unknown) => error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : 'Focus is unavailable. Check your session and connection.'
const startOfWeek = (date: Date) => { const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d }

export function TimerView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [sessions, setSessions] = useState<readonly FocusOut[]>([])
  const [tasks, setTasks] = useState<readonly TaskOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [taskId, setTaskId] = useState('')
  const [mode, setMode] = useState<Mode>('focus')
  const [preset, setPreset] = useState(25)
  const [breakStart, setBreakStart] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [linksNotice, setLinksNotice] = useState('')
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
      setLinksNotice(loadedTasks.status === 'rejected' || loadedProjects.status === 'rejected' ? 'Some task or project choices could not be loaded.' : '')
    } catch (error) { setNotice(errorText(error)); setStatus(navigator.onLine ? 'error' : 'offline') }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])
  const ticking = !!active || breakStart !== null
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])

  const elapsed = active ? Math.max(0, Math.floor((now - new Date(active.started_at).getTime()) / 1000)) : 0
  const secondsOf = (session: FocusOut) => session.id === active?.id ? elapsed : session.elapsed_seconds
  const shown: Mode = active ? (active.mode === 'stopwatch' ? 'stopwatch' : 'focus') : mode
  const breakLeft = breakStart === null ? preset * 60 : Math.max(0, preset * 60 - Math.floor((now - breakStart) / 1000))
  const breakRunning = breakStart !== null && breakLeft > 0
  const running = !!active || breakRunning
  const left = shown === 'break' ? breakLeft : Math.max(0, preset * 60 - elapsed)
  const time = shown === 'stopwatch' ? elapsed : shown === 'break' ? breakLeft : active ? left : preset * 60
  const filled = shown === 'stopwatch' ? (elapsed % 3600) / 36 : running || breakStart !== null ? 100 - (time / (preset * 60)) * 100 : 0
  const locked = running || !!pendingStart.current

  const pickMode = (next: Mode) => { setMode(next); setPreset(PRESETS[next][0] ?? 0); setBreakStart(null) }
  const start = async () => {
    if (mode === 'break') { setNow(Date.now()); setBreakStart(Date.now()); return }
    if (busy) return
    setBusy(true); setNotice('')
    try {
      const task = tasks.find((item) => item.id === taskId)
      pendingStart.current ??= { key: crypto.randomUUID(), body: { started_at: new Date().toISOString(), task_id: taskId || null, project_id: task?.project_id ?? null, mode: API_MODE[mode as 'focus' | 'stopwatch'] } }
      await getSharedApiClient().startFocusSession(pendingStart.current.body, { queueOnOffline: false, idempotencyKey: pendingStart.current.key })
      pendingStart.current = null
      await load()
    } catch (error) { setNotice(errorText(error)); await load() }
    finally { setBusy(false) }
  }
  const stop = async () => {
    if (breakStart !== null && !active) { setBreakStart(null); return }
    if (!active || busy) return
    setBusy(true); setNotice('')
    try { await getSharedApiClient().stopFocusSession(active.id, { queueOnOffline: false, query: { version: active.version } }); await load() }
    catch (error) { setNotice(errorText(error)) }
    finally { setBusy(false) }
  }

  const today = new Date().toDateString()
  const todays = sessions.filter((session) => new Date(session.started_at).toDateString() === today)
  const todayTotal = todays.reduce((sum, session) => sum + secondsOf(session), 0)
  const recent = [...sessions].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 5)
  const weekStart = startOfWeek(new Date())
  const week = Array.from({ length: 7 }, (_, day) => sessions.reduce((sum, session) => { const d = new Date(session.started_at); return startOfWeek(d).getTime() === weekStart.getTime() && (d.getDay() + 6) % 7 === day ? sum + secondsOf(session) : sum }, 0))
  const weekMax = Math.max(...week, 1)
  const todayIndex = (new Date().getDay() + 6) % 7
  const taskTitle = (session: FocusOut) => tasks.find((task) => task.id === session.task_id)?.title ?? (session.task_id ? 'Linked task' : `${session.mode === 'stopwatch' ? 'Stopwatch' : 'Focus'} session`)
  const projectName = projects.find((project) => project.id === (active?.project_id ?? tasks.find((task) => task.id === taskId)?.project_id))?.name
  const writeBlocked = apiStatus !== 'ready'

  return <div className="tl connected-workspace">
    <div className="tl-row"><div style={{ flex: 1 }}>{status === 'ready' && writeBlocked && <p className="tl-note" role="status">Cached focus history is available when previously loaded. Starting and stopping require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}</div>
      <div className="tl-seg" role="tablist" aria-label="Timer mode">{MODES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={shown === item.id} disabled={locked && shown !== item.id} onClick={() => pickMode(item.id)}>{item.label}</button>)}</div></div>
    {notice && <p className="tl-note" role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading focus sessions' : 'Focus sessions unavailable'} description="Check your connection and owner session."/> : <div className="tl-split">
      <section className="tl-card tl-ring-card" aria-label="Timer">
        <div className="tl-ring" style={{ background: `conic-gradient(#f06a58 ${filled}%, #efe9e4 0)` }}><div>
          <span className="tl-ring__phase">{MODES.find((item) => item.id === shown)?.label}</span>
          <span className="tl-ring__time" aria-label="Elapsed focus time">{clock(time)}</span>
          <span className="tl-muted">{active ? `Started ${new Date(active.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : breakRunning ? 'Break in progress' : 'Ready'}</span>
        </div></div>
        {PRESETS[shown].length > 0 && <div className="tl-chips" role="radiogroup" aria-label="Duration">{PRESETS[shown].map((minutes) => <button key={minutes} type="button" role="radio" aria-checked={preset === minutes} disabled={locked} onClick={() => setPreset(minutes)}>{minutes}</button>)}</div>}
        {shown !== 'break' && <label className="tl-task"><SquareCheck size={18} aria-hidden="true" />
          <select aria-label="Linked task" value={active?.task_id ?? taskId} disabled={locked} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">No linked task</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          {projectName && <span className="tl-muted">{projectName}</span>}</label>}
        {linksNotice && <p className="tl-note" role="status">{linksNotice}</p>}
        <div className="tl-actions">
          <button type="button" className="tl-primary" disabled={mode === 'break' ? false : busy || writeBlocked} onClick={() => void (running ? stop() : start())}>{running ? <Square size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}{running ? 'Stop' : 'Start'}</button>
          <button type="button" className="tl-icon-btn" aria-label="Reset" disabled={running || (breakStart === null && !pendingStart.current)} onClick={() => { pendingStart.current = null; setBreakStart(null); setNotice('') }}><RotateCcw size={18} aria-hidden="true" /></button>
        </div>
      </section>
      <div className="tl-stack">
        <section className="tl-card" aria-label="Today">
          <div className="tl-total"><span>Today</span><span>{duration(todayTotal)}</span></div>
          {todays.length > 0 && <div className="tl-bars">{todays.map((session) => <span key={session.id} style={{ flex: Math.max(secondsOf(session), 60) }} />)}</div>}
          <div className="tl-muted" style={{ marginTop: 8 }}>{todays.length ? `${todays.length} ${todays.length === 1 ? 'session' : 'sessions'}` : 'No sessions yet today'}</div>
        </section>
        <section className="tl-card" aria-label="Sessions"><h2>Sessions</h2>
          {recent.length ? recent.map((session) => <div className="tl-sess" key={session.id}>
            <span className="tl-dot" style={{ background: session.status === 'active' ? '#f06a58' : session.status === 'completed' ? '#14966c' : '#8c869a' }} />
            <div className="tl-sess__body"><div className="tl-sess__title">{taskTitle(session)}</div><div className="tl-muted">{new Date(session.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {session.status}</div></div>
            <span className="tl-sess__dur">{duration(secondsOf(session))}</span></div>) : <p className="tl-note">No focus sessions yet. Start one to see it here.</p>}
        </section>
        <section className="tl-card" aria-label="This week">
          <div className="tl-total"><span>This week</span><span className="tl-muted" style={{ fontSize: 13, fontWeight: 400 }}>{duration(week.reduce((a, b) => a + b, 0))}</span></div>
          <div className="tl-week">{week.map((seconds, day) => <div key={day}><i style={{ height: `${Math.max((seconds / weekMax) * 100, 4)}%`, background: day === todayIndex ? '#f06a58' : '#f9c9bf' }} /><span>{'MTWTFSS'[day]}</span></div>)}</div>
        </section>
      </div>
    </div>}
  </div>
}
