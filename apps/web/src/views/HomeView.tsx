import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AiCommandBar } from '../components/AiCommandBar'
import { Icon } from '../components/Icon'
import { SectionHeading } from '../components/SectionHeading'
import { StateCard } from '../components/StateCard'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { getSolarPeriod, selectWeatherBackground, weatherBackgroundUrl } from '../data/weather'
import { formatDate, formatTime, greetingForHour } from '../lib/format'
import { navigate } from '../lib/router'
import type { ApiStatus } from '../types'
import { getSharedApiClient } from '../lib/api'

const defaultWidgets = ['today', 'calendar', 'focus', 'projects']
const availableWidgets = [
  { id: 'today', label: 'Today', icon: 'check-square' as const },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' as const },
  { id: 'focus', label: 'Focus', icon: 'timer' as const },
  { id: 'projects', label: 'Projects', icon: 'folder' as const },
  { id: 'notes', label: 'Notes', icon: 'note' as const },
  { id: 'finance', label: 'Finance', icon: 'wallet' as const },
]

function useWidgetLayout() {
  const stored = window.localStorage.getItem('aelys.homeWidgets')
  const initial = stored ? (JSON.parse(stored) as string[]) : defaultWidgets
  const [widgets, setWidgets] = useState(initial)
  const save = (next: string[]) => { setWidgets(next); window.localStorage.setItem('aelys.homeWidgets', JSON.stringify(next)) }
  return { widgets, save }
}

type WidgetItem = { label: string; meta: string }

function WidgetCard({ widgetId, editMode, remove, status, items }: { widgetId: string; editMode: boolean; remove: () => void; status: ApiStatus; items: readonly WidgetItem[] }) {
  const widget = availableWidgets.find((item) => item.id === widgetId) ?? availableWidgets[0]
  const emptyTitle = widgetId === 'focus' ? 'No active session' : widgetId === 'today' ? 'Nothing due today' : widgetId === 'calendar' ? 'No events scheduled' : `No ${widget.label.toLowerCase()} yet`
  return <article className={`widget widget--${widgetId}`}>
    <div className="widget__heading"><span className="widget__title"><span className="widget__icon"><Icon name={widget.icon} size={16} /></span>{widget.label}</span>{editMode ? <button className="icon-button icon-button--small" onClick={remove} aria-label={`Remove ${widget.label} widget`}><Icon name="x" size={15} /></button> : <span className="widget__status">Connected data only</span>}</div>
    {status === 'ready' && items.length > 0 ? <div className="widget-records">{items.slice(0, 4).map((item) => <div className="widget-record" key={`${item.label}-${item.meta}`}><span>{item.label}</span><small>{item.meta}</small></div>)}</div> : <StateCard status={status === 'ready' ? 'empty' : status} title={status === 'loading' ? 'Loading connected data' : status === 'offline' ? 'Working offline' : status === 'error' ? 'Connected data unavailable' : emptyTitle} description={status === 'ready' ? 'This widget stays empty until the API or local store returns records.' : status === 'offline' ? 'Saved local preferences remain available; sync will resume when online.' : status === 'error' ? 'Check the API connection in Settings.' : 'The widget reads from the connected Aelys API.'} />}
  </article>
}

export function HomeView({ apiStatus }: { apiStatus: ApiStatus }) {
  const now = useMemo(() => new Date(), [])
  const period = getSolarPeriod(now)
  const background = selectWeatherBackground(period, 'unknown')
  const { widgets, save } = useWidgetLayout()
  const [editMode, setEditMode] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [dashboardStatus, setDashboardStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [dashboardItems, setDashboardItems] = useState<Record<string, readonly WidgetItem[]>>({})

  useEffect(() => {
    if (apiStatus !== 'ready') { setDashboardStatus(apiStatus); return }
    let active = true
    setDashboardStatus('loading')
    const client = getSharedApiClient()
    void Promise.allSettled([client.tasks(), client.calendarEvents(), client.projects()]).then(([tasks, events, projects]) => {
      if (!active) return
      const taskItems = tasks.status === 'fulfilled' ? tasks.value.slice(0, 4).map((item) => ({ label: item.title, meta: item.status || 'task' })) : []
      const calendarItems = events.status === 'fulfilled' ? events.value.slice(0, 4).map((item) => ({ label: item.title, meta: item.starts_at })) : []
      const projectItems = projects.status === 'fulfilled' ? projects.value.slice(0, 4).map((item) => ({ label: item.name, meta: item.status })) : []
      const anySuccess = [tasks, events, projects].some((result) => result.status === 'fulfilled')
      setDashboardItems({ today: taskItems, calendar: calendarItems, projects: projectItems })
      setDashboardStatus(anySuccess ? 'ready' : 'error')
    })
    return () => { active = false }
  }, [apiStatus])

  const addWidget = (id: string) => { if (!widgets.includes(id)) save([...widgets, id]); setShowAdd(false) }
  const removeWidget = (id: string) => save(widgets.filter((widget) => widget !== id))

  return <div className="page page--home">
    <section className="hero" style={{ '--hero-image': `url(${weatherBackgroundUrl(background)})` } as CSSProperties}>
      <div className="hero__overlay" />
      <div className="hero__top"><p className="hero__date">{formatDate(now)}</p><ApiStatusPill status={apiStatus} /></div>
      <div className="hero__copy"><p className="eyebrow">Local time · {period}</p><h1>{greetingForHour(now.getHours())}, Aelys</h1><p className="hero__subtitle">A calmer place to see what needs your attention.</p></div>
      <div className="hero__foot"><span className="hero__scene"><Icon name="sun" size={15} /> Photo backdrop follows your local solar period</span><span>{formatTime(now)}</span></div>
      <div className="hero__composer"><AiCommandBar /></div>
    </section>

    <section className="quick-actions" aria-label="Quick actions"><button onClick={() => navigate('/notes')}><Icon name="note" size={17} />New note</button><button onClick={() => navigate('/tasks')}><Icon name="check-square" size={17} />New task</button><button onClick={() => navigate('/timer')}><Icon name="timer" size={17} />Start focus</button><button onClick={() => navigate('/ai')}><Icon name="sparkles" size={17} />Ask Aelys</button></section>

    <div className="dashboard-heading"><SectionHeading eyebrow="Your day" title="At a glance" action={<button className="button button--quiet" onClick={() => setEditMode((value) => !value)}><Icon name="sliders" size={16} />{editMode ? 'Done' : 'Customize home'}</button>} /></div>
    {editMode && <div className="edit-panel"><div><strong>Arrange your home</strong><p>Widgets save locally on this device.</p></div><button className="button button--quiet" onClick={() => setShowAdd((value) => !value)}><Icon name="plus" size={16} />Add widget</button>{showAdd && <div className="widget-picker">{availableWidgets.filter((widget) => !widgets.includes(widget.id)).map((widget) => <button key={widget.id} onClick={() => addWidget(widget.id)}><Icon name={widget.icon} size={16} />{widget.label}</button>)}{availableWidgets.every((widget) => widgets.includes(widget.id)) && <span>All available widgets are on the home.</span>}</div>}</div>}

    {dashboardStatus !== 'ready' && dashboardStatus !== 'empty' && <div className="dashboard-state"><StateCard status={dashboardStatus} title={dashboardStatus === 'loading' ? 'Loading your day' : dashboardStatus === 'offline' ? 'Working offline' : 'The API is unavailable'} description={dashboardStatus === 'loading' ? 'Checking the configured API before loading connected widgets.' : dashboardStatus === 'offline' ? 'Only local preferences are available until the connection returns.' : 'Connected data is hidden until the configured API responds.'} /></div>}
    <section className="widget-grid" aria-label="Dashboard widgets">{widgets.map((widgetId) => <WidgetCard key={widgetId} widgetId={widgetId} editMode={editMode} remove={() => removeWidget(widgetId)} status={dashboardStatus} items={dashboardItems[widgetId] ?? []} />)}</section>
  </div>
}
