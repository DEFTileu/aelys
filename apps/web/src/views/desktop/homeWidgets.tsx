import type { CSSProperties } from 'react'
import { Check, ChevronRight, FileText, FolderOpen, Play, Square, type AelysIconComponent } from '../../icons'
import type { ActivityEvent, EventOut, FinanceTransaction, MailMessage, NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { FOCUS_SESSION_SECONDS, accentOf, type AccentKey } from '../../data/desktop/home'
import { formatMoney, sumDecimals } from '../../lib/money'
import { useWeather } from '../../lib/weather'
import { navigate } from '../../lib/router'
import { WIDGET_CATALOG, type WidgetId } from './homeLayout'
import type { ApiStatus } from '../../types'
import { WidgetFrame, type WidgetFrameControls } from './WidgetFrame'
import { WeatherCard } from '../../components/Weather'

export type HomeData = { tasks: readonly TaskOut[]; events: readonly EventOut[]; projects: readonly ProjectResponse[]; notes: readonly NoteOut[]; finance: readonly FinanceTransaction[]; mail?: readonly MailMessage[]; activity?: readonly ActivityEvent[]; states?: Partial<Record<WidgetId, ApiStatus>> }
export type FocusTimer = { left: number; running: boolean; disabled: boolean; toggle: () => void; reset: () => void }

const pad = (value: number) => String(value).padStart(2, '0')
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
const completed = (task: TaskOut) => ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
function Empty({ children }: { children: string }) { return <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: '20px' }}>{children}</div> }
function IconTile({ color, icon: Icon, box = 32, iconSize = 16, radius = 10 }: { color: AccentKey; icon: AelysIconComponent; box?: number; iconSize?: number; radius?: number }) { const { c, soft } = accentOf(color); return <span style={{ width: box, height: box, flex: 'none', borderRadius: radius, background: soft, color: c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={iconSize} /></span> }
function Progress({ pct, color }: { pct: number; color: string }) { return <div style={{ height: 4, borderRadius: 2, background: 'var(--line)', marginTop: 4 }}><div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, background: color }} /></div> }

function WidgetBody({ id, span, mobile, large, focus, data, onToggleTask }: { id: WidgetId; span: number; mobile: boolean; large: boolean; focus: FocusTimer; data: HomeData; onToggleTask: (task: TaskOut) => void }) {
  const cols = !mobile && span > 1 ? 2 : 1
  const state = data.states?.[id]
  if (state && state !== 'ready') return <Empty>{state === 'loading' ? 'Loading records…' : 'Records unavailable. Check the connection or owner session.'}</Empty>
  if (id === 'today') return <div>{data.tasks.slice(0, mobile && !large ? 3 : 5).map((task) => { const checked = completed(task); return <div key={task.id} className="home-task-row" style={{ display: 'flex', alignItems: 'center', gap: 12, height: 36 }}><button type="button" role="checkbox" aria-checked={checked} aria-label={task.title} className="home-btn" onClick={() => onToggleTask(task)} style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', border: checked ? 'none' : '2px solid #BDB7C2', background: checked ? '#6A4CF2' : 'transparent', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{checked && <Check size={12} />}</button><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: checked ? 'var(--muted)' : 'var(--ink)', textDecoration: checked ? 'line-through' : 'none' }}>{task.title}</span><span style={{ fontSize: 13, color: 'var(--muted)' }}>{time(task.due_at)}</span></div> })}{data.tasks.length === 0 && <Empty>No tasks yet.</Empty>}</div>
  if (id === 'cal') return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{data.events.slice(0, mobile && !large ? 3 : 4).map((event) => { const start = new Date(event.starts_at); const end = new Date(event.ends_at); return <div key={event.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span style={{ width: 42, flex: 'none', whiteSpace: 'nowrap', fontSize: mobile ? 13 : 12, lineHeight: '20px', color: 'var(--muted)' }}>{time(event.starts_at)}</span><div style={{ flex: 1, minWidth: 0, padding: mobile ? '6px 12px' : '4px 12px', borderRadius: 10, background: 'var(--purple-soft)', borderLeft: '3px solid #4A8EF0' }}><div style={{ fontSize: mobile ? 14 : 13, lineHeight: mobile ? '20px' : '18px', fontWeight: 500 }}>{event.title}</div><div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--ink-soft)' }}>{`${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`}</div></div></div> })}{data.events.length === 0 && <Empty>No events scheduled.</Empty>}</div>
  if (id === 'focus') { const pct = Math.min(100, Math.round((focus.left / FOCUS_SESSION_SECONDS) * 100)); return <div className="home-focus-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexDirection: span > 1 ? 'row' : 'column' }}><div className="home-focus-ring" style={{ width: 128, height: 128, borderRadius: '50%', background: `conic-gradient(from 0deg,#F9C29A,#F06A58 ${pct}%,#ECE5DF ${pct}%)`, padding: 8 }}><div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'var(--surface-solid)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}><div className="home-focus-time" style={{ fontSize: 30, fontWeight: 700 }}>{`${pad(Math.floor(focus.left / 60))}:${pad(focus.left % 60)}`}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Elapsed focus</div></div></div><div className="home-focus-controls" style={{ display: 'flex', gap: 8 }}><button type="button" className="home-btn home-focus-toggle" disabled={focus.disabled} title={focus.running ? 'Stop' : 'Start'} aria-label={focus.running ? 'Stop focus' : 'Start focus'} onClick={focus.toggle}>{focus.running ? <Square size={16} /> : <Play size={16} />}</button><button type="button" className="home-btn home-focus-btn" disabled={focus.disabled || !focus.running} title="Stop" aria-label="Finish focus" onClick={focus.reset}><Square size={12} /></button><button type="button" className="home-btn home-focus-btn home-focus-mode" onClick={() => navigate('/timer')}>Timer<ChevronRight size={16} /></button></div></div> }
  if (id === 'weather') return <WeatherCard compact={mobile && span === 1} />

  if (id === 'proj') return <div className="home-records" style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: '12px 20px' }}>{data.projects.slice(0, mobile && !large ? 2 : 3).map((project) => { const own = data.tasks.filter((task) => task.project_id === project.id); const pct = own.length ? Math.round(own.filter(completed).length / own.length * 100) : 0; const ready = data.states?.today === 'ready'; return <div key={project.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}><IconTile color="violet" icon={FolderOpen} box={mobile ? 36 : 40} iconSize={18} radius={12} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', fontSize: 14, lineHeight: '20px', fontWeight: 500 }}><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span><span style={{ fontSize: mobile ? 13 : 12, color: 'var(--muted)' }}>{ready && own.length ? `${pct}%` : project.status}</span></div><div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ready && own.length ? `${own.length} ${own.length === 1 ? 'task' : 'tasks'}` : project.description || 'No description yet.'}</div>{!ready ? <small>Task progress unavailable</small> : <Progress pct={pct} color={accentOf('violet').c} />}</div></div> })}{data.projects.length === 0 && <Empty>No projects yet.</Empty>}</div>
  if (id === 'notes' || id === 'kb') return <div className="home-records" style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: '6px 20px' }}>{data.notes.slice(0, mobile && span === 1 ? 1 : 4).map((note) => <button type="button" className="home-btn home-note-row" key={note.id} onClick={() => navigate(id === 'kb' ? '/knowledge' : '/notes')}>
    {!mobile && <IconTile color={id === 'kb' ? 'violet' : 'orange'} icon={FileText} box={32} />}<span><strong>{note.title}</strong>{mobile && <small>{note.markdown_body || 'Empty note'}</small>}</span>
  </button>)}{data.notes.length === 0 && <Empty>No notes yet.</Empty>}</div>
  if (id === 'fin') {
    const currencies = [...new Set(data.finance.map(item => item.currency))]
    return <div>{currencies.map(currency => <div key={currency} className="home-finance-total"><strong>{formatMoney(sumDecimals(data.finance.filter(item => item.currency === currency).map(item => item.amount)))}</strong><span>{currency}</span></div>)}{data.finance.slice(0, mobile && span === 1 ? 1 : 3).map(item => <div key={item.id} className="home-finance-row"><span /><span>{item.notes || item.type}</span><b>{item.amount} {item.currency}</b></div>)}{data.finance.length === 0 && <Empty>No transactions yet.</Empty>}</div>
  }
  if (id === 'mail') return <div>{data.mail?.slice(0, mobile && !large ? 2 : 4).map((item) => <button className="home-btn home-mail-row" type="button" key={item.id} onClick={() => navigate('/mail')}><span className="home-mail-avatar">{item.sender[0]?.toUpperCase()}</span><span><strong>{item.sender.replace(/<.*?>/g, '').trim() || item.sender}</strong><small>{item.subject || '(No subject)'}</small></span><time>{new Date(item.received_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</time></button>)}{!data.mail?.length && <Empty>No imported mail yet.</Empty>}</div>
  return <div className="home-activity">{data.activity?.slice(0, 6).map((item) => <div key={item.id}><IconTile color="violet" icon={FileText} box={36} /><span><strong>{item.event_kind.replace(/[._]/g, ' ')}</strong><small>{item.actor_kind}</small></span><time>{new Date(item.occurred_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</time></div>)}{!data.activity?.length && <Empty>No recorded activity yet.</Empty>}</div>
}

export type HomeWidgetProps = {
  id: WidgetId; span: number; index: number; count: number; editing: boolean; mobile?: boolean
  focus: FocusTimer; data: HomeData; onToggleTask: (task: TaskOut) => void
  onMove: (delta: -1 | 1) => void; onRemove: () => void; frame: WidgetFrameControls
}

export function HomeWidget({ id, span, index, count, editing, mobile = false, focus, data, onToggleTask, onRemove, frame }: HomeWidgetProps) {
  const { location } = useWeather()
  const def = WIDGET_CATALOG[id]
  const { c, soft } = accentOf(def.color)
  const dark = id === 'weather'
  const doneCount = data.tasks.filter(completed).length
  const badge = id === 'today' && data.tasks.length ? String(Math.max(0, data.tasks.length - doneCount)) : ''
  const style: CSSProperties = {
    background: dark ? 'linear-gradient(180deg,rgba(30,34,60,.30),rgba(20,22,40,.72)),url("/backgrounds/aelys/actual-wallpaper.png") 82% 40%/auto 420px' : 'var(--glass-bg, rgba(255,255,255,.88))',
    color: dark ? '#fff' : 'var(--ink)',
    border: '1px solid rgba(255,255,255,.35)',
  }
  const route = def.link?.route ?? ({ today: '/tasks', focus: '/timer', fin: '/finance' } as const)[id as 'today' | 'focus' | 'fin']
  const meta = id === 'weather' ? location?.name : id === 'cal' ? new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : id === 'fin' ? 'Balance' : ''
  const Icon = def.icon
  return <WidgetFrame controls={frame} style={style} editing={editing} onRemove={onRemove} canMoveEarlier={index > 0} canMoveLater={index < count - 1}>
    <div data-widget-heading="" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginBottom: 10 }}>
      <span style={{ width: 28, height: 28, flex: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dark ? 'rgba(255,255,255,.22)' : soft, color: dark ? '#fff' : c }}><Icon size={16} /></span>
      <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.title}</span>
      {badge && <span style={{ minWidth: 22, height: 20, padding: '0 6px', borderRadius: 10, background: 'var(--surface-soft)', fontSize: 12, fontWeight: 600, lineHeight: '20px', textAlign: 'center' }}>{badge}</span>}
      {!mobile && meta && <span className="home-widget-meta" title={meta}>{meta}</span>}
      <span style={{ flex: 1 }} />
      {!editing && mobile && route && <button type="button" className="home-btn home-mobile-open" aria-label={`Open ${def.title}`} onClick={() => navigate(route)}><ChevronRight size={20} /></button>}
      {!editing && !mobile && def.link && <button type="button" className="home-btn home-link" onClick={def.link.route ? () => navigate(def.link!.route!) : undefined}>{def.link.label}<ChevronRight size={16} /></button>}

    </div>
    <div className="home-widget-body" inert={editing || undefined}><WidgetBody id={id} span={span} mobile={mobile} large={(frame.height ?? 264) > 400} focus={focus} data={data} onToggleTask={onToggleTask} /></div>
  </WidgetFrame>
}
