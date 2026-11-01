import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, LayoutGrid, Plus, RotateCcw } from '../icons'
import { AddWidgetSheet } from './desktop/AddWidgetSheet'
import { HOME_CHIPS } from '../data/desktop/home'
import { askAelys, takeCustomizeHome, useDesktopState, useWindowWidth } from '../lib/desktopStore'
import { navigate } from '../lib/router'
import { getSharedApiClient } from '../lib/api'
import type { FocusIn, FocusOut, TaskOut } from '@aelys/shared'
import type { ApiStatus } from '../types'
import { DEFAULT_LAYOUT, MOBILE_DEFAULT_LAYOUT, WIDGET_CATALOG, layoutKey, pendingHighlight, newLayoutEntry, readLayout, reorderLayout, saveLayout, normalizeWidgetSize, type LayoutEntry, type SizeKey, type WidgetId } from './desktop/homeLayout'
import { HomeWidget, type HomeData, type FocusTimer } from './desktop/homeWidgets'

// Orb gradient from the design; the AppShell hero stays outside this view.
const ORB = 'radial-gradient(circle at 32% 28%,#fff 0,rgba(235,225,255,.9) 9%,transparent 28%),radial-gradient(circle at 72% 72%,#FF7AD9 0,transparent 48%),radial-gradient(circle at 24% 72%,#46D2FF 0,transparent 46%),radial-gradient(circle at 50% 50%,#6E4CF5 0,#2A1590 82%)'

const isLive = (item: FocusOut) => item.status === 'active' || item.status === 'paused'
const EMPTY_DATA: HomeData = { tasks: [], events: [], projects: [], notes: [], finance: [] }

export function HomeView({ apiStatus }: { apiStatus?: ApiStatus }) {
  const mobile = useWindowWidth() <= 700
  const [desktopLayout, setDesktopLayout] = useState<LayoutEntry[]>(() => readLayout())
  const [mobileLayout, setMobileLayout] = useState<LayoutEntry[]>(() => readLayout(true))
  const layout = mobile ? mobileLayout : desktopLayout
  const setLayout = mobile ? setMobileLayout : setDesktopLayout
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
    void Promise.allSettled([client.tasks(), client.calendarOccurrences(today.toISOString(), tomorrow.toISOString()), client.projects(), client.notes(), client.financeTransactions(), client.focusSessions(), client.mailMessages(), client.activity(), client.financeBudgets()]).then(([tasks, events, projects, notes, finance, focusSessions, mail, activity, budgets]) => {
      if (!active) return
      setData({
        tasks: tasks.status === 'fulfilled' ? tasks.value : [],
        events: events.status === 'fulfilled' ? events.value : [],
        projects: projects.status === 'fulfilled' ? projects.value : [],
        notes: notes.status === 'fulfilled' ? notes.value : [],
        finance: finance.status === 'fulfilled' ? finance.value : [],
        mail: mail.status === 'fulfilled' ? mail.value : [],
        // Budgets only add a row to Finances; a failed load simply omits it.
        budgets: budgets.status === 'fulfilled' ? budgets.value : [],
        activity: activity.status === 'fulfilled' ? activity.value : [],
        states: { today: tasks.status === 'fulfilled' ? 'ready' : 'error', cal: events.status === 'fulfilled' ? 'ready' : 'error', proj: projects.status === 'fulfilled' ? 'ready' : 'error', notes: notes.status === 'fulfilled' ? 'ready' : 'error', fin: finance.status === 'fulfilled' ? 'ready' : 'error', focus: focusSessions.status === 'fulfilled' ? 'ready' : 'error', mail: mail.status === 'fulfilled' ? 'ready' : 'error', activity: activity.status === 'fulfilled' ? 'ready' : 'error', kb: notes.status === 'fulfilled' ? 'ready' : 'error' },
      })
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

  const visibleLayout = homeToggles[3] ? layout : layout.filter(([id]) => id !== 'activity')

  return <div className={`home-screen${editing ? ' home-screen--editing' : ''}`} style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
    {homeToggles[2] && <section aria-label="Ask Aelys" data-glass="" style={{ padding: 16, borderRadius: 24, background: 'var(--dw-section, rgba(255,255,255,.72))', backdropFilter: 'blur(20px)', border: '1px solid var(--dw-edge, rgba(255,255,255,.35))', boxShadow: '0 8px 28px rgba(40,30,30,.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div aria-hidden="true" style={{ width: 48, height: 48, flex: 'none', borderRadius: '50%', background: ORB, boxShadow: '0 0 20px rgba(130,100,255,.5)' }} />
        <label className="home-composer" style={{ flex: 1, height: 56, borderRadius: 28, background: 'var(--dw-btn, #fff)', display: 'flex', alignItems: 'center', padding: '0 8px 0 20px', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
          <input className="home-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(draft) }} placeholder="Ask Aelys or take an action…" aria-label="Ask Aelys or take an action" style={{ flex: 1, fontSize: 16, lineHeight: '24px' }} />
          <button type="button" className="home-btn home-send" onClick={() => ask(draft)} aria-label="Send" title="Send" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ArrowRight size={18} aria-hidden="true" /></button>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {HOME_CHIPS.map((chip) => <button key={chip.label} type="button" className="home-btn home-chip" onClick={() => askAelys(chip.label)}><chip.icon size={16} style={{ color: chip.color }} aria-hidden="true" />{chip.label}</button>)}
      </div>
    </section>}

    <div ref={layoutToolbar} className="home-layout-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 600 }}>My day</h2>
      </div>
      {editing
? <>
          <button type="button" className="home-btn home-tool" aria-label="Reset layout" title="Reset to default layout" onClick={resetLayout}><RotateCcw size={16} aria-hidden="true" /></button>
          <button type="button" className="home-btn home-tool home-done" onClick={() => { setEditing(false); setSheet(false) }} style={{ padding: '0 16px', fontSize: 14 }}><Check size={18} aria-hidden="true" />Done</button>
          <button type="button" className="home-btn home-add" aria-haspopup="dialog" aria-label="Add widget" onClick={() => setSheet(true)}><Plus size={18} aria-hidden="true" />Widget</button>
        </>
        : <button type="button" className="home-btn home-tool" onClick={() => setEditing(true)}><LayoutGrid size={16} aria-hidden="true" />{mobile ? 'Customize home' : 'Customize'}</button>}
    </div>

    {apiStatus !== 'ready' && <p role="status">{apiStatus === 'loading' ? 'Loading workspace…' : 'Workspace offline or unavailable. Showing cached records where available; changes require a connection (OFFLINE_WRITE_UNAVAILABLE).'}</p>}
    {taskNotice && <p role="status">{taskNotice}</p>}
    {layoutNotice && <p role="status">{layoutNotice}</p>}
    {editing && <p className="home-layout-help">Drag a card to move it, drag its corner to resize to S, M, L or Tall.</p>}
    {homeToggles[1] && <section ref={grid} aria-label="Dashboard widgets" className={`home-widget-grid${editing ? ' home-widget-grid--editing' : ''}`}>
      {visibleLayout.map((entry) => {
        const [id, span, height] = entry
        const key = layoutKey(entry)
        return <HomeWidget key={key} id={id} editing={editing} mobile={mobile} focus={focus} data={data} onToggleTask={(task) => void toggleTask(task)} onAddTask={addTask} onRetry={() => setReload((value) => value + 1)} onRemove={() => removeWidget(key)} onLongPress={mobile ? () => setEditing(true) : undefined} frame={{ id, itemKey: key, title: WIDGET_CATALOG[id].title, span, height, onDrop: (source, target) => commit(reorderLayout(layout, source, target)), onMove: (delta) => moveWidget(key, delta), onSize: (width, nextHeight) => sizeWidget(key, width, nextHeight) }} />
      })}
    </section>}
    <div style={{ height: 12 }} />
    {sheet && <AddWidgetSheet layout={layout} onAdd={addWidget} onClose={() => setSheet(false)} />}
  </div>
}
