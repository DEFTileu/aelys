import type { CSSProperties } from 'react'
import { Move } from 'lucide-react'
import { ChevronRight, RefreshCw } from '../../icons'
import type { ActivityEvent, EventOut, FinanceBudget, FinanceTransaction, FocusOut, MailMessage, NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { accentOf } from '../../data/desktop/home'
import { openWeatherSettings, refreshWeather, useWeather } from '../../lib/weather'
import { useWallpaper } from '../../lib/wallpaper'
import { navigate } from '../../lib/router'
import { WIDGET_CATALOG, type WidgetId } from './homeLayout'
import type { ApiStatus } from '../../types'
import { WidgetFrame, type WidgetFrameControls } from './WidgetFrame'
import { WidgetBody, isDone } from './widgetBodies'
import { dayTasks } from './desktopBodies'

export type HomeData = { tasks: readonly TaskOut[]; events: readonly EventOut[]; projects: readonly ProjectResponse[]; notes: readonly NoteOut[]; finance: readonly FinanceTransaction[]; mail?: readonly MailMessage[]; budgets?: readonly FinanceBudget[]; activity?: readonly ActivityEvent[]; focusSessions?: readonly FocusOut[]; states?: Partial<Record<WidgetId | 'activity', ApiStatus>> }
export type FocusTimer = { left: number; running: boolean; paused: boolean; live: boolean; disabled: boolean; toggle: () => void; reset: () => void }

export type HomeWidgetProps = {
  id: WidgetId; editing: boolean; mobile?: boolean
  focus: FocusTimer; data: HomeData; onToggleTask: (task: TaskOut) => void; onAddTask: (title: string) => Promise<boolean>; onRetry: () => void
  onRemove: () => void; onLongPress?: () => void; frame: WidgetFrameControls
}

export function HomeWidget({ id, editing, mobile = false, focus, data, onToggleTask, onAddTask, onRetry, onRemove, onLongPress, frame }: HomeWidgetProps) {
  const { location } = useWeather()
  const wallpaper = useWallpaper()
  const def = WIDGET_CATALOG[id]
  const { soft, ink } = accentOf(def.color)
  const dark = id === 'weather'
  const unread = (data.mail ?? []).filter((item) => item.is_read === false).length
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const sessions = (data.focusSessions ?? []).filter((session) => Date.parse(session.started_at) >= todayStart.getTime()).length
  const open = id === 'today' ? dayTasks(data.tasks).filter((task) => !isDone(task)).length : 0
  const badge = id === 'today' ? (dayTasks(data.tasks).length ? String(open) : '') : id === 'mail' && unread ? String(unread) : ''
  const style: CSSProperties = {
    background: dark ? `linear-gradient(180deg,rgba(30,34,60,.30),rgba(20,22,40,.72)),url(${JSON.stringify(wallpaper)}) center/cover` : 'var(--glass-bg, rgba(255,255,255,.88))',
    color: dark ? '#fff' : 'var(--ink)',
  }
  const route = def.link?.route ?? ({ today: '/tasks', focus: '/timer', fin: '/finance' } as const)[id as 'today' | 'focus' | 'fin']
  const meta = id === 'weather' ? location?.name : id === 'cal' ? new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : id === 'fin' ? new Date().toLocaleDateString('en-US', { month: 'long' }) : id === 'focus' && sessions ? `Session ${sessions}` : ''
  const Icon = def.icon
  return <WidgetFrame controls={frame} style={style} editing={editing} onRemove={onRemove} onLongPress={onLongPress}>
    {size => <>
    <div data-widget-heading="" className="dw-head">
      {editing && !mobile
        ? <span className="dw-head-move" title="Drag"><Move size={16} aria-hidden="true" /></span>
        : <span className="dw-head-icon" style={{ background: dark ? 'rgba(255,255,255,.22)' : soft, color: dark ? '#fff' : ink }}><Icon size={16} /></span>}
      <span className="dw-head-title">{def.title}</span>
      {!editing && badge && <span className="dw-head-badge" style={id === 'mail' ? { background: 'var(--dw-mail-badge)', color: 'var(--dw-mail-badge-ink)' } : undefined}>{badge}</span>}
      {mobile
        ? null
        : id === 'weather' && !editing && location
          ? <button type="button" className="home-btn dw-head-meta home-widget-meta" title="Change city" onClick={openWeatherSettings}>{meta}</button>
          : <span className="dw-head-meta home-widget-meta" title={editing ? undefined : meta}>{editing ? '' : meta}</span>}
      {!editing && mobile && route && <button type="button" className="home-btn home-mobile-open" aria-label={`Open ${def.title}`} onClick={() => navigate(route)}><ChevronRight size={20} /></button>}
      {!editing && !mobile && def.link && <button type="button" className="home-btn home-link dw-head-link" onClick={def.link.route ? () => navigate(def.link!.route!) : undefined}>{def.link.label}<ChevronRight size={16} /></button>}
      {!editing && !mobile && id === 'weather' && location && <><a className="dw-head-link" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a><button type="button" className="home-btn dw-head-link" aria-label="Refresh weather" title="Refresh weather" onClick={() => void refreshWeather(true)}><RefreshCw size={14} aria-hidden="true" /></button></>}
    </div>
    <div className="home-widget-body" inert={editing || undefined}><WidgetBody id={id} size={size.key} mobile={mobile} focus={focus} data={data} onToggleTask={onToggleTask} onAddTask={onAddTask} onRetry={onRetry} /></div>
    </>}
  </WidgetFrame>
}
