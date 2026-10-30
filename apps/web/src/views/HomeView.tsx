import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, LayoutGrid, Plus, RotateCcw } from '../icons'
import { HOME_CHIPS, accentOf } from '../data/desktop/home'
import { askAelys, takeCustomizeHome, useDesktopState } from '../lib/desktopStore'
import { getSharedApiClient } from '../lib/api'
import type { FocusIn, FocusOut, TaskOut } from '@aelys/shared'
import type { ApiStatus } from '../types'
import { DEFAULT_LAYOUT, WIDGET_CATALOG, WIDGET_IDS, readLayout, reorderLayout, saveLayout, normalizeWidgetSize, type LayoutEntry, type WidgetId } from './desktop/homeLayout'
import { HomeWidget, type HomeData, type FocusTimer } from './desktop/homeWidgets'

// Orb gradient from the design; the AppShell hero stays outside this view.
const ORB = 'radial-gradient(circle at 32% 28%,#fff 0,rgba(235,225,255,.9) 9%,transparent 28%),radial-gradient(circle at 72% 72%,#FF7AD9 0,transparent 48%),radial-gradient(circle at 24% 72%,#46D2FF 0,transparent 46%),radial-gradient(circle at 50% 50%,#6E4CF5 0,#2A1590 82%)'

const EMPTY_DATA: HomeData = { tasks: [], events: [], projects: [], notes: [], finance: [] }

export function HomeView({ apiStatus }: { apiStatus?: ApiStatus }) {
  const [layout, setLayout] = useState<LayoutEntry[]>(readLayout)
  const [editing, setEditing] = useState(false)
  const [picker, setPicker] = useState(false)
  const { customizeHome, homeToggles } = useDesktopState()
  const [draft, setDraft] = useState('')
  const [taskNotice, setTaskNotice] = useState('')
  const [layoutNotice, setLayoutNotice] = useState('')
  const [data, setData] = useState<HomeData>(EMPTY_DATA)
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
    void Promise.allSettled([client.tasks(), client.calendarOccurrences(today.toISOString(), tomorrow.toISOString()), client.projects(), client.notes(), client.financeTransactions(), client.focusSessions(), client.mailMessages(), client.activity()]).then(([tasks, events, projects, notes, finance, focusSessions, mail, activity]) => {
      if (!active) return
      setData({
        tasks: tasks.status === 'fulfilled' ? tasks.value : [],
        events: events.status === 'fulfilled' ? events.value : [],
        projects: projects.status === 'fulfilled' ? projects.value : [],
        notes: notes.status === 'fulfilled' ? notes.value : [],
        finance: finance.status === 'fulfilled' ? finance.value : [],
        mail: mail.status === 'fulfilled' ? mail.value : [],
        activity: activity.status === 'fulfilled' ? activity.value : [],
        states: { today: tasks.status === 'fulfilled' ? 'ready' : 'error', cal: events.status === 'fulfilled' ? 'ready' : 'error', proj: projects.status === 'fulfilled' ? 'ready' : 'error', notes: notes.status === 'fulfilled' ? 'ready' : 'error', fin: finance.status === 'fulfilled' ? 'ready' : 'error', focus: focusSessions.status === 'fulfilled' ? 'ready' : 'error', mail: mail.status === 'fulfilled' ? 'ready' : 'error', activity: activity.status === 'fulfilled' ? 'ready' : 'error', kb: notes.status === 'fulfilled' ? 'ready' : 'error' },
      })
      if (focusSessions.status === 'fulfilled') setFocusSession(focusSessions.value.find((item) => item.status === 'active') ?? null)
    })
    return () => { active = false }
  }, [apiStatus])
  useEffect(() => { if (!focusSession) return; const timer = window.setInterval(() => setFocusTick((value) => value + 1), 1000); return () => window.clearInterval(timer) }, [focusSession])
  const changeFocus = async (stopOnly = false) => {
    if (focusLock.current || apiStatus !== 'ready' || (stopOnly && !focusSession)) return
    focusLock.current = true; setFocusBusy(true); setTaskNotice('')
    try {
      const client = getSharedApiClient()
      if (focusSession) await client.stopFocusSession(focusSession.id, { queueOnOffline: false, query: { version: focusSession.version } })
      else {
        focusStart.current ??= { body: { started_at: new Date().toISOString(), mode: 'pomodoro' }, key: crypto.randomUUID() }
        await client.startFocusSession(focusStart.current.body, { queueOnOffline: false, idempotencyKey: focusStart.current.key })
        focusStart.current = null
      }
      setFocusSession((await client.focusSessions()).find((item) => item.status === 'active') ?? null)
    } catch { setTaskNotice('Focus action could not be confirmed. Open Timer and refresh before retrying.') }
    finally { focusLock.current = false; setFocusBusy(false) }
  }
  const focus = useMemo<FocusTimer>(() => {
    const elapsed = focusSession ? Math.max(0, Math.floor((Date.now() - new Date(focusSession.started_at).getTime()) / 1000)) : 0
    return { left: focusSession ? elapsed : 0, running: !!focusSession, disabled: focusBusy || apiStatus !== 'ready', toggle: () => { void changeFocus() }, reset: () => { void changeFocus(true) } }
  }, [focusSession, focusTick, focusBusy, apiStatus])
  // The sidebar Widgets item sets this flag and navigates here.
  useEffect(() => { if (takeCustomizeHome()) setEditing(true) }, [customizeHome])
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

  const commit = (next: LayoutEntry[]) => { if (!editing) return; setLayout(next); setLayoutNotice(saveLayout(next) ? '' : 'Не удалось сохранить расположение. Разрешите локальное хранилище браузера.') }
  const onMyDay = layout.map(([id]) => id)
  const available = WIDGET_IDS.filter((id) => !onMyDay.includes(id))
  const addWidget = (id: WidgetId) => {
    commit([...layout.filter(([w]) => w !== 'activity'), [id, 1, 240], ...layout.filter(([w]) => w === 'activity')])
    setPicker(false)
  }
  const moveWidget = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= layout.length) return
    commit(reorderLayout(layout, layout[index][0], layout[target][0]))
  }
  const sizeWidget = (id: WidgetId, span: number, height: number) => { const size = normalizeWidgetSize(span, height); commit(layout.map((entry) => entry[0] === id ? [id, size.span, size.height] : entry)) }
  const removeWidget = (index: number) => commit(layout.filter((_, i) => i !== index))
  const resetLayout = () => { commit(DEFAULT_LAYOUT.map((entry) => [...entry] as LayoutEntry)); setPicker(false) }

  const visibleLayout = homeToggles[3] ? layout : layout.filter(([id]) => id !== 'activity')

  return <div className="home-screen" style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
    {homeToggles[2] && <section aria-label="Ask Aelys" data-glass="" style={{ padding: 16, borderRadius: 24, background: 'rgba(255,255,255,.72)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,.35)', boxShadow: '0 8px 28px rgba(40,30,30,.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div aria-hidden="true" style={{ width: 48, height: 48, flex: 'none', borderRadius: '50%', background: ORB, boxShadow: '0 0 20px rgba(130,100,255,.5)' }} />
        <label className="home-composer" style={{ flex: 1, height: 56, borderRadius: 28, background: '#fff', display: 'flex', alignItems: 'center', padding: '0 8px 0 20px', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
          <input className="home-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(draft) }} placeholder="Ask Aelys or take an action…" aria-label="Ask Aelys or take an action" style={{ flex: 1, fontSize: 16, lineHeight: '24px' }} />
          <button type="button" className="home-btn home-send" onClick={() => ask(draft)} aria-label="Send" title="Send" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ArrowRight size={18} aria-hidden="true" /></button>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {HOME_CHIPS.map((chip) => <button key={chip.label} type="button" className="home-btn home-chip" onClick={() => askAelys(chip.label)}><chip.icon size={16} color={chip.color} aria-hidden="true" />{chip.label}</button>)}
      </div>
    </section>}

    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 600, letterSpacing: '-.01em' }}>My day</h2>
        <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500, color: '#4F4A56' }}>{visibleLayout.length} widgets</span>
      </div>
      {editing
        ? <>
          <button type="button" className="home-btn home-tool" onClick={() => { setEditing(false); setPicker(false) }} style={{ padding: '0 16px', fontSize: 14 }}><Check size={18} aria-hidden="true" />Done</button>
          <div style={{ position: 'relative' }}>
            <button type="button" className="home-btn home-add" aria-haspopup="menu" aria-expanded={picker} onClick={() => setPicker((value) => !value)}><Plus size={18} aria-hidden="true" />Widget</button>
            {picker && <div role="menu" aria-label="Add to My day" className="home-picker" style={{ position: 'absolute', right: 0, top: 48, zIndex: 20, width: 300, padding: 8, borderRadius: 16, background: '#fff', boxShadow: '0 18px 50px rgba(20,10,30,.22)', border: '1px solid #EFEAE6' }}>
              <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#625D69', padding: '6px 10px' }}>Add to My day</div>
              {available.map((id) => {
                const def = WIDGET_CATALOG[id]
                const { c, soft } = accentOf(def.color)
                return <button key={id} type="button" role="menuitem" className="home-btn home-picker-item" onClick={() => addWidget(id)}>
                  <span style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: soft, color: c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><def.icon size={16} aria-hidden="true" /></span>
                  <span style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                    <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{def.title}</span>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: '#625D69' }}>{def.description}</span>
                  </span>
                  <Plus size={16} color="#5132D6" aria-hidden="true" />
                </button>
              })}
              {available.length === 0 && <div style={{ padding: '12px 10px', fontSize: 13, color: '#625D69' }}>All widgets are already on My day.</div>}
              <button type="button" role="menuitem" className="home-btn home-picker-item home-picker-reset" onClick={resetLayout}><RotateCcw size={16} aria-hidden="true" />Reset to default layout</button>
            </div>}
          </div>
        </>
        : <button type="button" className="home-btn home-tool" onClick={() => setEditing(true)}><LayoutGrid size={16} aria-hidden="true" />Customize</button>}
    </div>

    {apiStatus !== 'ready' && <p role="status">{apiStatus === 'loading' ? 'Loading workspace…' : 'Workspace offline or unavailable. Showing cached records where available; changes require a connection (OFFLINE_WRITE_UNAVAILABLE).'}</p>}
    {taskNotice && <p role="status">{taskNotice}</p>}
    {layoutNotice && <p role="status">{layoutNotice}</p>}
    {editing && <p className="home-layout-help">Переносите виджеты по сетке. Выберите размер карточки или потяните за угол.</p>}
    {homeToggles[1] && <section aria-label="Dashboard widgets" className={`home-widget-grid${editing ? ' home-widget-grid--editing' : ''}`}>
      {visibleLayout.map(([id, span, height], index) => <HomeWidget key={id} id={id} span={span} index={index} count={visibleLayout.length} editing={editing} focus={focus} data={data} onToggleTask={(task) => void toggleTask(task)} onMove={(delta) => moveWidget(layout.findIndex(([widgetId]) => widgetId === id), delta)} onRemove={() => removeWidget(layout.findIndex(([widgetId]) => widgetId === id))} frame={{ id, title: WIDGET_CATALOG[id].title, span, height, onDrop: (source, target) => commit(reorderLayout(layout, source, target)), onMove: (delta) => moveWidget(layout.findIndex(([widgetId]) => widgetId === id), delta), onSize: (width, nextHeight) => sizeWidget(id, width, nextHeight) }} />)}
    </section>}
    <div style={{ height: 12 }} />
  </div>
}
