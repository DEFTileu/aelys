import type { CSSProperties } from 'react'
import { ChevronRight } from '../../icons'
import type { ActivityEvent, EventOut, FinanceTransaction, FocusOut, MailMessage, NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { accentOf } from '../../data/desktop/home'
import { useWeather } from '../../lib/weather'
import { navigate } from '../../lib/router'
import { WIDGET_CATALOG, type WidgetId } from './homeLayout'
import type { ApiStatus } from '../../types'
import { WidgetFrame, type WidgetFrameControls } from './WidgetFrame'
import { WidgetBody, isDone } from './widgetBodies'

export type HomeData = { tasks: readonly TaskOut[]; events: readonly EventOut[]; projects: readonly ProjectResponse[]; notes: readonly NoteOut[]; finance: readonly FinanceTransaction[]; mail?: readonly MailMessage[]; activity?: readonly ActivityEvent[]; focusSessions?: readonly FocusOut[]; states?: Partial<Record<WidgetId, ApiStatus>> }
export type FocusTimer = { left: number; running: boolean; paused: boolean; live: boolean; disabled: boolean; toggle: () => void; reset: () => void }

export type HomeWidgetProps = {
  id: WidgetId; editing: boolean; mobile?: boolean
  focus: FocusTimer; data: HomeData; onToggleTask: (task: TaskOut) => void; onAddTask: (title: string) => Promise<boolean>; onRetry: () => void
  onRemove: () => void; onLongPress?: () => void; frame: WidgetFrameControls
}

export function HomeWidget({ id, editing, mobile = false, focus, data, onToggleTask, onAddTask, onRetry, onRemove, onLongPress, frame }: HomeWidgetProps) {
  const { location } = useWeather()
  const def = WIDGET_CATALOG[id]
  const { c, soft } = accentOf(def.color)
  const dark = id === 'weather'
  const doneCount = data.tasks.filter(isDone).length
  const badge = id === 'today' && data.tasks.length ? String(Math.max(0, data.tasks.length - doneCount)) : ''
  const style: CSSProperties = {
    background: dark ? 'linear-gradient(180deg,rgba(30,34,60,.30),rgba(20,22,40,.72)),url("/backgrounds/aelys/actual-wallpaper.png") 82% 40%/auto 420px' : 'var(--glass-bg, rgba(255,255,255,.88))',
    color: dark ? '#fff' : 'var(--ink)',
    border: '1px solid rgba(255,255,255,.35)',
  }
  const route = def.link?.route ?? ({ today: '/tasks', focus: '/timer', fin: '/finance' } as const)[id as 'today' | 'focus' | 'fin']
  const meta = id === 'weather' ? location?.name : id === 'cal' ? new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : id === 'fin' ? 'Balance' : ''
  const Icon = def.icon
  return <WidgetFrame controls={frame} style={style} editing={editing} onRemove={onRemove} onLongPress={onLongPress}>
    {size => <>
    <div data-widget-heading="" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginBottom: 10 }}>
      <span style={{ width: 28, height: 28, flex: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dark ? 'rgba(255,255,255,.22)' : soft, color: dark ? '#fff' : c }}><Icon size={16} /></span>
      <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.title}</span>
      {badge && <span style={{ minWidth: 22, height: 20, padding: '0 6px', borderRadius: 10, background: 'var(--surface-soft)', fontSize: 12, fontWeight: 600, lineHeight: '20px', textAlign: 'center' }}>{badge}</span>}
      {!mobile && meta && <span className="home-widget-meta" title={meta}>{meta}</span>}
      <span style={{ flex: 1 }} />
      {!editing && mobile && route && <button type="button" className="home-btn home-mobile-open" aria-label={`Open ${def.title}`} onClick={() => navigate(route)}><ChevronRight size={20} /></button>}
      {!editing && !mobile && def.link && <button type="button" className="home-btn home-link" onClick={def.link.route ? () => navigate(def.link!.route!) : undefined}>{def.link.label}<ChevronRight size={16} /></button>}

    </div>
    <div className="home-widget-body" inert={editing || undefined}><WidgetBody id={id} size={size.key} mobile={mobile} focus={focus} data={data} onToggleTask={onToggleTask} onAddTask={onAddTask} onRetry={onRetry} /></div>
    </>}
  </WidgetFrame>
}
