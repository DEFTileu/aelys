import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AiCommandBar } from '../components/AiCommandBar'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import { getSolarPeriod, selectWeatherBackground, weatherBackgroundUrl } from '../data/weather'
import { formatDate, formatTime, greetingForHour } from '../lib/format'
import { getSharedApiClient } from '../lib/api'
import { navigate } from '../lib/router'
import type { ApiStatus } from '../types'

const defaultWidgets = ['today', 'calendar', 'focus', 'weather', 'projects', 'notes', 'finance', 'knowledge', 'activity']
const availableWidgets = [
  { id: 'today', label: 'Today', icon: 'check-square' as const },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' as const },
  { id: 'focus', label: 'Focus', icon: 'timer' as const },
  { id: 'weather', label: 'Weather', icon: 'sun' as const },
  { id: 'projects', label: 'Projects', icon: 'folder' as const },
  { id: 'notes', label: 'Notes', icon: 'note' as const },
  { id: 'finance', label: 'Finance', icon: 'wallet' as const },
  { id: 'knowledge', label: 'Knowledge base', icon: 'book' as const },
  { id: 'activity', label: 'Recent activity', icon: 'sparkles' as const },
]

type WidgetItem = { label: string; meta: string }

function useWidgetLayout() {
  const stored = window.localStorage.getItem('aelys.homeWidgets')
  let initial = defaultWidgets
  try { if (stored) initial = JSON.parse(stored) as string[] } catch { /* recover with the default layout */ }
  const [widgets, setWidgets] = useState(initial)
  const save = (next: string[]) => { setWidgets(next); window.localStorage.setItem('aelys.homeWidgets', JSON.stringify(next)) }
  return { widgets, save }
}

function EmptyWidget({ widgetId, status }: { widgetId: string; status: ApiStatus }) {
  const title = widgetId === 'focus' ? 'No active session' : widgetId === 'today' ? 'Nothing due today' : widgetId === 'calendar' ? 'No events scheduled' : widgetId === 'weather' ? 'Weather is not connected' : widgetId === 'knowledge' ? 'No knowledge yet' : widgetId === 'activity' ? 'No recent activity' : `No ${widgetId} yet`
  const description = status === 'offline' ? 'Available again when this device reconnects.' : status === 'error' ? 'Check the API connection in Settings.' : 'Records will appear here when available.'
  return <StateCard status={status === 'ready' ? 'empty' : status} title={title} description={description} />
}

function WidgetCard({ widgetId, editMode, remove, status, items, background }: { widgetId: string; editMode: boolean; remove: () => void; status: ApiStatus; items: readonly WidgetItem[]; background: string }) {
  const widget = availableWidgets.find((item) => item.id === widgetId) ?? availableWidgets[0]
  const isWeather = widgetId === 'weather'
  return <article className={`widget widget--${widgetId} ${isWeather ? 'widget--photo' : ''}`} style={isWeather ? { '--widget-image': `url(${background})` } as CSSProperties : undefined}>
    {isWeather && <div className="widget__photo-overlay" />}
    <div className="widget__heading"><span className="widget__title"><span className="widget__icon"><Icon name={widget.icon} size={16} /></span>{widget.label}</span><span className="widget__actions">{editMode ? <button className="icon-button icon-button--small" onClick={remove} aria-label={`Remove ${widget.label} widget`}><Icon name="x" size={15} /></button> : <Icon name="more-horizontal" size={16} />}</span></div>
    <div className="widget__content">{status === 'ready' && items.length > 0 ? <div className="widget-records">{items.slice(0, 4).map((item) => <div className="widget-record" key={`${item.label}-${item.meta}`}><span>{item.label}</span><small>{item.meta}</small></div>)}</div> : isWeather ? <div className="photo-widget-copy"><strong>Local atmosphere</strong><span>Choose a connected weather source in Settings.</span></div> : <EmptyWidget widgetId={widgetId} status={status} />}</div>
  </article>
}

export function HomeView({ apiStatus }: { apiStatus: ApiStatus }) {
  const now = useMemo(() => new Date(), [])
  const period = getSolarPeriod(now)
  const background = selectWeatherBackground(period, 'unknown')
  const backgroundUrl = weatherBackgroundUrl(background)
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
    void Promise.allSettled([client.tasks(), client.calendarEvents(), client.projects(), client.notes(), client.financeTransactions()]).then(([tasks, events, projects, notes, finance]) => {
      if (!active) return
      const taskItems = tasks.status === 'fulfilled' ? tasks.value.slice(0, 4).map((item) => ({ label: item.title, meta: item.status || 'task' })) : []
      const calendarItems = events.status === 'fulfilled' ? events.value.slice(0, 4).map((item) => ({ label: item.title, meta: new Date(item.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })) : []
      const projectItems = projects.status === 'fulfilled' ? projects.value.slice(0, 4).map((item) => ({ label: item.name, meta: item.status })) : []
      const noteItems = notes.status === 'fulfilled' ? notes.value.slice(0, 4).map((item) => ({ label: item.title, meta: 'note' })) : []
      const financeItems = finance.status === 'fulfilled' ? finance.value.slice(0, 4).map((item) => ({ label: item.notes || item.type, meta: `${item.amount} ${item.currency}` })) : []
      const results = [tasks, events, projects, notes, finance]
      setDashboardItems({ today: taskItems, calendar: calendarItems, projects: projectItems, notes: noteItems, finance: financeItems })
      setDashboardStatus(results.some((result) => result.status === 'fulfilled') ? 'ready' : 'error')
    })
    return () => { active = false }
  }, [apiStatus])

  const addWidget = (id: string) => { if (!widgets.includes(id)) save([...widgets, id]); setShowAdd(false) }
  const removeWidget = (id: string) => save(widgets.filter((widget) => widget !== id))

  return <div className="page page--home home-canvas" style={{ '--home-image': `url(${backgroundUrl})` } as CSSProperties}>
    <section className="hero" style={{ '--hero-image': `url(${backgroundUrl})` } as CSSProperties}>
      <div className="hero__overlay" />
      <div className="hero__top"><div><p className="hero__date">{formatDate(now)}</p><span className="hero__location"><Icon name="sun" size={13} /> {period} atmosphere</span></div><div className="hero__controls"><ApiStatusPill status={apiStatus} /><button className="hero__circle" aria-label="Notifications"><Icon name="bell" size={17} /></button></div></div>
      <div className="hero__copy"><p className="eyebrow">Your personal space</p><h1>{greetingForHour(now.getHours())}, Tileuzhan</h1><p className="hero__subtitle">A calm day creates bigger results.</p></div>
      <div className="hero__composer"><AiCommandBar /><div className="hero__chips"><button onClick={() => navigate('/tasks')}><Icon name="calendar" size={14} />Plan my day</button><button onClick={() => navigate('/search')}><Icon name="search" size={14} />Find something</button><button onClick={() => navigate('/notes')}><Icon name="note" size={14} />Create a note</button><button onClick={() => navigate('/ai')}><Icon name="sparkles" size={14} />Ask Aelys</button></div></div>
      <div className="hero__foot"><span><Icon name="timer" size={14} /> {formatTime(now)}</span><span>Photo backdrop · {background.id.replaceAll('-', ' ')}</span></div>
    </section>
    <section className="quick-actions" aria-label="Quick actions"><button onClick={() => navigate('/notes')}><Icon name="note" size={17} />New note</button><button onClick={() => navigate('/tasks')}><Icon name="check-square" size={17} />New task</button><button onClick={() => navigate('/timer')}><Icon name="timer" size={17} />Start focus</button></section>
    <div className="dashboard-heading"><div className="section-heading"><div><h2>My day</h2><span className="dashboard-count">{widgets.length} widgets</span></div><div className="section-heading__action"><button className="button button--quiet" onClick={() => setEditMode((value) => !value)}><Icon name="grid" size={16} />{editMode ? 'Done' : 'Customize'}</button></div></div></div>
    {editMode && <div className="edit-panel"><div><strong>Arrange your day</strong><p>Changes save locally on this device.</p></div><button className="button button--primary" onClick={() => setShowAdd((value) => !value)}><Icon name="plus" size={16} />Add widget</button>{showAdd && <div className="widget-picker">{availableWidgets.filter((widget) => !widgets.includes(widget.id)).map((widget) => <button key={widget.id} onClick={() => addWidget(widget.id)}><Icon name={widget.icon} size={16} />{widget.label}</button>)}</div>}</div>}
    {dashboardStatus !== 'ready' && dashboardStatus !== 'empty' && <div className="dashboard-state"><StateCard status={dashboardStatus} title={dashboardStatus === 'loading' ? 'Loading your day' : dashboardStatus === 'offline' ? 'Working offline' : 'The API is unavailable'} description={dashboardStatus === 'loading' ? 'Checking connected sources.' : dashboardStatus === 'offline' ? 'Local preferences remain available until the connection returns.' : 'Connected data is hidden until the configured API responds.'} /></div>}
    <section className="widget-grid" aria-label="Dashboard widgets">{widgets.map((widgetId) => <WidgetCard key={widgetId} widgetId={widgetId} editMode={editMode} remove={() => removeWidget(widgetId)} status={dashboardStatus} items={dashboardItems[widgetId] ?? []} background={backgroundUrl} />)}</section>
  </div>
}
