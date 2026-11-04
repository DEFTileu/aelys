import { ApiError } from '@aelys/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { askAelys, takeCustomizeHome, useDesktopState } from '../../lib/desktopStore'
import { getSharedApiClient } from '../../lib/api'
import type { FocusIn, FocusOut, TaskOut } from '@aelys/shared'
import type { ApiStatus } from '../../types'
import { DEFAULT_LAYOUT, MOBILE_DEFAULT_LAYOUT, layoutKey, pendingHighlight, newLayoutEntry, readLayout, reorderLayout, saveLayout, normalizeWidgetSize, type LayoutEntry, type SizeKey, type WidgetId } from '../desktop/homeLayout'
import type { HomeData, FocusTimer } from '../desktop/homeWidgets'

// Orb gradient from the design; the AppShell hero stays outside this view.
export const ORB = 'radial-gradient(circle at 32% 28%,#fff 0,rgba(235,225,255,.9) 9%,transparent 28%),radial-gradient(circle at 72% 72%,#FF7AD9 0,transparent 48%),radial-gradient(circle at 24% 72%,#46D2FF 0,transparent 46%),radial-gradient(circle at 50% 50%,#6E4CF5 0,#2A1590 82%)'

const isLive = (item: FocusOut) => item.status === 'active' || item.status === 'paused'
const EMPTY_DATA: HomeData = { tasks: [], events: [], projects: [], notes: [], finance: [] }

export function useHome(apiStatus: ApiStatus | undefined, mobile: boolean) {
  const [layout, setLayout] = useState<LayoutEntry[]>(() => readLayout(mobile))
  const [editing, setEditing] = useState(false)
  const grid = useRef<HTMLElement>(null)
  const layoutToolbar = useRef<HTMLDivElement>(null)
  useEffect(() => { if (mobile && editing) layoutToolbar.current?.scrollIntoView?.({ block:'nearest' }) }, [mobile, editing])
  const [sheet, setSheet] = useState(false)
  const [highlight, setHighlight] = useState(pendingHighlight.key)
  const { customizeHome, homeToggles } = useDesktopState()
  const [draft, setDraft] = useState('')
  const [taskNotice, setTaskNotice] = useState('')
  const [layoutNotice, setLayoutNotice] = useState('')
  const [liveData, setData] = useState<HomeData>(EMPTY_DATA)
  const [reload, setReload] = useState(0)
  const data = liveData
  const [focusSession, setFocusSession] = useState<FocusOut | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [focusBusy, setFocusBusy] = useState(false)
  const focusLock = useRef(false)
  const focusStart = useRef<{ body: FocusIn; key: string } | null>(null)
  useEffect(() => {
    let active = true
    const client = getSharedApiClient()
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
    setData((current) => ({ ...current, states: Object.fromEntries(['today', 'cal', 'proj', 'notes', 'fin', 'focus', 'mail', 'kb', 'activity'].map((id) => [id, 'loading'])) }))
    let rejected = false
    const preview = (key: 'notes' | 'mail') => (value: unknown) => {
      if (active && !rejected) setData(current => ({ ...current, [key]: (value as { items: readonly unknown[] }).items, states: { ...current.states, [key]: 'ready' } }))
    }
    const readOptions = { forceRefresh: reload > 0 }
    const notesPage = client.notesPage({ limit: 10 }, { forceRefresh: reload > 0, onCached: preview('notes') }).then(page => { preview('notes')(page); return page.items })
    const mailPage = client.mailPage({ limit: 10 }, { forceRefresh: reload > 0, onCached: preview('mail') }).then(page => { preview('mail')(page); return page.items })
    const guard = <T,>(request: Promise<T>) => request.catch((error: unknown) => {
      if (active && error instanceof ApiError && [401, 403].includes(error.status)) { rejected = true; setData(EMPTY_DATA); setFocusSession(null) }
      throw error
    })
    void Promise.allSettled([guard(client.tasks(undefined, readOptions)), guard(client.calendarOccurrences(today.toISOString(), tomorrow.toISOString(), readOptions)), guard(client.projects(readOptions)), guard(notesPage), guard(client.financeTransactions(readOptions)), guard(client.focusSessions(readOptions)), guard(mailPage), guard(client.activity(readOptions)), guard(client.financeBudgets(readOptions))]).then(([tasks, events, projects, notes, finance, focusSessions, mail, activity, budgets]) => {
      if (!active) return
      rejected = [tasks, events, projects, notes, finance, focusSessions, mail, activity, budgets].some(result => result.status === 'rejected' && result.reason instanceof ApiError && [401, 403].includes(result.reason.status))
      if (rejected) { setData(EMPTY_DATA); setFocusSession(null); return }
      setData(current => ({
        tasks: tasks.status === 'fulfilled' ? tasks.value : [],
        events: events.status === 'fulfilled' ? events.value : [],
        projects: projects.status === 'fulfilled' ? projects.value : [],
        notes: notes.status === 'fulfilled' ? notes.value : current.notes,
        finance: finance.status === 'fulfilled' ? finance.value : [],
        mail: mail.status === 'fulfilled' ? mail.value : current.mail,
        // Budgets only add a row to Finances; a failed load simply omits it.
        budgets: budgets.status === 'fulfilled' ? budgets.value : [],
        activity: activity.status === 'fulfilled' ? activity.value : [],
        states: { today: tasks.status === 'fulfilled' ? 'ready' : 'error', cal: events.status === 'fulfilled' ? 'ready' : 'error', proj: projects.status === 'fulfilled' ? 'ready' : 'error', notes: notes.status === 'fulfilled' ? 'ready' : 'error', fin: finance.status === 'fulfilled' ? 'ready' : 'error', focus: focusSessions.status === 'fulfilled' ? 'ready' : 'error', mail: mail.status === 'fulfilled' ? 'ready' : 'error', activity: activity.status === 'fulfilled' ? 'ready' : 'error', kb: notes.status === 'fulfilled' ? 'ready' : 'error' },
      }))
      if (focusSessions.status === 'fulfilled') setData((current) => ({ ...current, focusSessions: focusSessions.value }))
      if (focusSessions.status === 'fulfilled') setFocusSession(focusSessions.value.find(isLive) ?? null)
    })
    return () => { active = false }
  }, [apiStatus, reload])
  useEffect(() => { if (!focusSession || focusSession.status === 'paused') return; const timer = window.setInterval(() => setFocusTick((value) => value + 1), 1000); return () => window.clearInterval(timer) }, [focusSession])
  const changeFocus = async (stopOnly = false) => {
    if (focusLock.current || apiStatus !== 'ready' || (stopOnly && !focusSession)) return
    focusLock.current = true; setFocusBusy(true); setTaskNotice('')
    try {
      const client = getSharedApiClient()
      if (focusSession && stopOnly) await client.stopFocusSession(focusSession.id, { queueOnOffline: false, query: { version: focusSession.version } })
      else if (focusSession) await (focusSession.status === 'paused' ? client.resumeFocusSession : client.pauseFocusSession).call(client, focusSession.id, focusSession.version)
      else {
        focusStart.current ??= { body: { started_at: new Date().toISOString(), mode: 'pomodoro' }, key: crypto.randomUUID() }
        await client.startFocusSession(focusStart.current.body, { queueOnOffline: false, idempotencyKey: focusStart.current.key })
        focusStart.current = null
      }
      const sessions = await client.focusSessions()
      setFocusSession(sessions.find(isLive) ?? null); setData((current) => ({ ...current, focusSessions: sessions }))
    } catch { setTaskNotice('Focus action could not be confirmed. Open Timer and refresh before retrying.') }
    finally { focusLock.current = false; setFocusBusy(false) }
  }
  const focus = useMemo<FocusTimer>(() => {
    const paused = focusSession?.status === 'paused'
    const elapsed = !focusSession ? 0 : paused ? focusSession.elapsed_seconds : Math.max(0, Math.floor((Date.now() - new Date(focusSession.started_at).getTime()) / 1000) - (focusSession.paused_seconds ?? 0))
    return { left: elapsed, running: !!focusSession && !paused, paused, live: !!focusSession, disabled: focusBusy || apiStatus !== 'ready', toggle: () => { void changeFocus() }, reset: () => { void changeFocus(true) } }
  }, [focusSession, focusTick, focusBusy, apiStatus])
  // The sidebar Widgets item sets this flag and navigates here.
  useEffect(() => { if (takeCustomizeHome()) { setEditing(true); if (!mobile) setSheet(true) } }, [customizeHome])
  // Escape leaves edit mode; an open sheet or an active drag handles Escape itself first.
  useEffect(() => {
    if (!editing) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sheet) setEditing(false) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [editing, sheet])
  // A newly added card scrolls into view with a short highlight.
  useEffect(() => {
    if (!highlight) return
    pendingHighlight.key = ''
    const node = grid.current?.querySelector<HTMLElement>(`[data-widget-key="${highlight}"]`)
    node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    node?.setAttribute('data-new', '')
    const timer = window.setTimeout(() => { node?.removeAttribute('data-new'); setHighlight('') }, 1600)
    return () => window.clearTimeout(timer)
  }, [highlight, layout])
  const ask = (text: string) => { const value = text.trim(); if (value) { setDraft(''); askAelys(value) } }

  const toggleTask = async (task: TaskOut) => {
    setTaskNotice('')
    if (apiStatus !== 'ready') { setTaskNotice('OFFLINE_WRITE_UNAVAILABLE: Connect before changing a task.'); return }
    try {
      const { id, ...body } = task
      const saved = await getSharedApiClient().updateTask(id, { ...body, status: ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase()) ? 'todo' : 'completed' }, { queueOnOffline: false })
      setData((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === saved.id ? saved : item) }))
    } catch { setTaskNotice('Could not confirm the task change. Check your owner session and connection.') }
  }

  const addTask = async (title: string) => {
    setTaskNotice('')
    if (apiStatus !== 'ready') { setTaskNotice('OFFLINE_WRITE_UNAVAILABLE: Connect before adding a task.'); return false }
    try {
      const saved = await getSharedApiClient().createTask({ title }, { queueOnOffline: false })
      setData((current) => ({ ...current, tasks: [...current.tasks, saved] }))
      return true
    } catch { setTaskNotice('Could not confirm the new task. Check your owner session and connection.'); return false }
  }

  const commit = (next: LayoutEntry[]) => { if (!editing) return; setLayout(next); setLayoutNotice(saveLayout(next, mobile) ? '' : 'Could not save the layout. Allow local browser storage') }
  const addWidget = (id: WidgetId, size: SizeKey) => {
    const entry = newLayoutEntry(id, size, layout)
    commit([...layout, entry])
    setHighlight(layoutKey(entry)); setSheet(false)
  }
  const moveWidget = (key: string, delta: -1 | 1) => {
    const index = layout.findIndex((entry) => layoutKey(entry) === key)
    const target = layout[index + delta]
    if (index >= 0 && target) commit(reorderLayout(layout, key, layoutKey(target)))
  }
  const sizeWidget = (key: string, span: number, height: number) => { const size = normalizeWidgetSize(span, height); commit(layout.map((entry) => layoutKey(entry) === key ? (entry[3] ? [entry[0], size.span, size.height, entry[3]] : [entry[0], size.span, size.height]) as LayoutEntry : entry)) }
  const removeWidget = (key: string) => commit(layout.filter((entry) => layoutKey(entry) !== key))
  const resetLayout = () => commit((mobile ? MOBILE_DEFAULT_LAYOUT : DEFAULT_LAYOUT).map((entry) => [...entry] as LayoutEntry))

  return { layout, editing, setEditing, grid, layoutToolbar, sheet, setSheet, homeToggles, draft, setDraft, taskNotice, layoutNotice, data, setReload, focus, ask, toggleTask, addTask, commit, addWidget, moveWidget, sizeWidget, removeWidget, resetLayout }
}
