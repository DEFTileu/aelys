import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusIn, FocusOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { Pause, Play, Square } from '../../icons'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'

export type Mode = 'focus' | 'break' | 'stopwatch'
export const MODES: readonly { id: Mode; label: string }[] = [{ id: 'focus', label: 'Focus' }, { id: 'break', label: 'Break' }, { id: 'stopwatch', label: 'Stopwatch' }]
export const PRESETS: Record<Mode, readonly number[]> = { focus: [25, 50, 90], break: [5, 10, 15], stopwatch: [] }
// The API has no break concept: breaks are a local countdown that is never saved. Focus and stopwatch sessions can pause.
const API_MODE: Record<'focus' | 'stopwatch', string> = { focus: 'pomodoro', stopwatch: 'stopwatch' }

const pad = (value: number) => String(value).padStart(2, '0')
export const clock = (seconds: number) => seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
export const duration = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 60)}m`
const errorText = (error: unknown) => error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : 'Focus is unavailable. Check your session and connection.'
const startOfWeek = (date: Date) => { const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d }


export function useTimer(apiStatus: ApiStatus) {
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
  const active = sessions.find((session) => session.status === 'active' || session.status === 'paused')
  const paused = active?.status === 'paused'
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
  const ticking = (!!active && !paused) || breakStart !== null
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])

  const elapsed = !active ? 0 : paused ? active.elapsed_seconds : Math.max(0, Math.floor((now - new Date(active.started_at).getTime()) / 1000) - (active.paused_seconds ?? 0))
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
  // A stale version means another device changed the session: show the notice and reload the real state.
  const change = async (run: (id: string, version: number) => Promise<unknown>) => {
    if (!active || busy) return
    setBusy(true); setNotice('')
    try { await run(active.id, active.version); await load() }
    catch (error) { setNotice(errorText(error)); if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') await load() }
    finally { setBusy(false) }
  }
  const stop = async () => {
    if (breakStart !== null && !active) { setBreakStart(null); return }
    await change((id, version) => getSharedApiClient().stopFocusSession(id, { queueOnOffline: false, query: { version } }))
  }
  const pause = () => change((id, version) => getSharedApiClient().pauseFocusSession(id, version))
  const resume = () => change((id, version) => getSharedApiClient().resumeFocusSession(id, version))
  const primary = paused ? { label: 'Resume', Icon: Play, run: resume } : active ? { label: 'Pause', Icon: Pause, run: pause } : breakRunning ? { label: 'Stop', Icon: Square, run: stop } : { label: 'Start', Icon: Play, run: start }

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
  return {
    apiStatus, sessions, tasks, projects, taskId, setTaskId, mode, setMode, preset, setPreset, breakStart, setBreakStart,
    notice, setNotice, busy, setBusy, status, linksNotice, now, pendingStart, active, paused, load, elapsed, secondsOf, shown,
    breakLeft, breakRunning, running, left, time, filled, locked, pickMode, start, stop, primary, todays, todayTotal, recent,
    week, weekMax, todayIndex, taskTitle, projectName, writeBlocked,
  }
}
