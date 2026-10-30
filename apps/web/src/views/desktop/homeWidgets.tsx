import type { CSSProperties } from 'react'
import { Check, ChevronRight, FileText, FolderOpen, Play, Square, type AelysIconComponent } from '../../icons'
import type { ActivityEvent, EventOut, FinanceTransaction, MailMessage, NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { FOCUS_SESSION_SECONDS, accentOf, type AccentKey } from '../../data/desktop/home'
import { navigate } from '../../lib/router'
import { WIDGET_CATALOG, type WidgetId } from './homeLayout'
import type { ApiStatus } from '../../types'
import { WidgetFrame, type WidgetFrameControls } from './WidgetFrame'
import { WeatherCard } from '../../components/Weather'

export type HomeData = { tasks: readonly TaskOut[]; events: readonly EventOut[]; projects: readonly ProjectResponse[]; notes: readonly NoteOut[]; finance: readonly FinanceTransaction[]; mail?: readonly MailMessage[]; activity?: readonly ActivityEvent[]; states?: Partial<Record<WidgetId, ApiStatus>> }
export type FocusTimer = { left: number; running: boolean; disabled: boolean; toggle: () => void; reset: () => void }

const pad = (value: number) => String(value).padStart(2, '0')
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
const completed = (task: TaskOut) => ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
function Empty({ children }: { children: string }) { return <div style={{ color: '#625D69', fontSize: 13, lineHeight: '20px' }}>{children}</div> }
function IconTile({ color, icon: Icon, box = 32, iconSize = 16, radius = 10 }: { color: AccentKey; icon: AelysIconComponent; box?: number; iconSize?: number; radius?: number }) { const { c, soft } = accentOf(color); return <span style={{ width: box, height: box, flex: 'none', borderRadius: radius, background: soft, color: c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={iconSize} /></span> }
function Progress({ pct, color }: { pct: number; color: string }) { return <div style={{ height: 4, borderRadius: 2, background: '#ECE7E3', marginTop: 4 }}><div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, background: color }} /></div> }

function WidgetBody({ id, span, focus, data, onToggleTask }: { id: WidgetId; span: number; focus: FocusTimer; data: HomeData; onToggleTask: (task: TaskOut) => void }) {
  const cols = span > 1 ? 2 : 1
  const state = data.states?.[id]
  if (state && state !== 'ready') return <Empty>{state === 'loading' ? 'Loading records…' : 'Records unavailable. Check the connection or owner session.'}</Empty>
  if (id === 'today') return <div>{data.tasks.slice(0, 5).map((task) => { const checked = completed(task); return <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 12, height: 36 }}><button type="button" role="checkbox" aria-checked={checked} aria-label={task.title} className="home-btn" onClick={() => onToggleTask(task)} style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', border: checked ? 'none' : '2px solid #BDB7C2', background: checked ? '#6A4CF2' : 'transparent', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{checked && <Check size={12} />}</button><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: checked ? '#625D69' : '#1C1B22', textDecoration: checked ? 'line-through' : 'none' }}>{task.title}</span><span style={{ fontSize: 13, color: '#625D69' }}>{time(task.due_at)}</span></div> })}{data.tasks.length === 0 && <Empty>No tasks yet.</Empty>}</div>
  if (id === 'cal') return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{data.events.slice(0, 4).map((event) => { const start = new Date(event.starts_at); const end = new Date(event.ends_at); return <div key={event.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span style={{ width: 40, flex: 'none', fontSize: 12, color: '#625D69' }}>{time(event.starts_at)}</span><div style={{ flex: 1, minWidth: 0, padding: '4px 12px', borderRadius: 10, background: '#E4EEFD', borderLeft: '3px solid #4A8EF0' }}><div style={{ fontSize: 13, fontWeight: 500 }}>{event.title}</div><div style={{ fontSize: 12, color: '#4F4A56' }}>{`${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</div></div></div> })}{data.events.length === 0 && <Empty>No events scheduled.</Empty>}</div>
  if (id === 'focus') { const pct = Math.min(100, Math.round((focus.left / FOCUS_SESSION_SECONDS) * 100)); return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexDirection: span > 1 ? 'row' : 'column' }}><div style={{ width: 128, height: 128, borderRadius: '50%', background: `conic-gradient(from 0deg,#F9C29A,#F06A58 ${pct}%,#ECE5DF ${pct}%)`, padding: 8 }}><div style={{ width: '100%', height: '100%', borderRadius: '50%', background: '#FDFBFA', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}><div style={{ fontSize: 30, fontWeight: 700 }}>{`${pad(Math.floor(focus.left / 60))}:${pad(focus.left % 60)}`}</div><div style={{ fontSize: 12, color: '#625D69' }}>Elapsed focus</div></div></div><div style={{ display: 'flex', gap: 8 }}><button type="button" className="home-btn home-focus-toggle" disabled={focus.disabled} title={focus.running ? 'Stop' : 'Start'} aria-label={focus.running ? 'Stop focus' : 'Start focus'} onClick={focus.toggle}>{focus.running ? <Square size={16} /> : <Play size={16} />}</button><button type="button" className="home-btn home-focus-btn" disabled={focus.disabled || !focus.running} title="Stop" aria-label="Finish focus" onClick={focus.reset}><Square size={12} /></button><button type="button" className="home-btn home-focus-btn" onClick={() => navigate('/timer')}>Timer<ChevronRight size={16} /></button></div></div> }
  if (id === 'weather') return <WeatherCard />

  if (id === 'proj') return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: '12px 20px' }}>{data.projects.map((project) => <div key={project.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}><IconTile color="violet" icon={FolderOpen} box={40} iconSize={18} radius={12} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', fontSize: 14, fontWeight: 500 }}><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span><span style={{ fontSize: 12, color: '#625D69' }}>{project.status}</span></div><div style={{ fontSize: 12, color: '#625D69', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.description || 'No description yet.'}</div>{data.states?.today !== 'ready' ? <small>Task progress unavailable</small> : <Progress pct={data.tasks.filter((task) => task.project_id === project.id).length ? data.tasks.filter((task) => task.project_id === project.id && completed(task)).length / data.tasks.filter((task) => task.project_id === project.id).length * 100 : 0} color={accentOf('violet').c} />}</div></div>)}{data.projects.length === 0 && <Empty>No projects yet.</Empty>}</div>
  if (id === 'notes' || id === 'kb') return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: '6px 20px' }}>{data.notes.slice(0, 4).map((note) => <div key={note.id} style={{ display: 'flex', alignItems: 'center', gap: 12, height: 38 }}><IconTile color="orange" icon={FileText} box={32} /><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.title}</span><span style={{ fontSize: 12, color: '#625D69' }}>note</span></div>)}{data.notes.length === 0 && <Empty>No notes yet.</Empty>}</div>
  if (id === 'fin') return <div>{data.finance.slice(0, 4).map((item) => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, height: 32, borderTop: '1px solid #EFEAE6', fontSize: 13 }}><span style={{ width: 8, height: 8, borderRadius: 3, background: '#2BC48F' }} /><span style={{ flex: 1 }}>{item.notes || item.type}</span><span style={{ fontWeight: 500 }}>{item.amount} {item.currency}</span></div>)}{data.finance.length === 0 && <Empty>No transactions yet.</Empty>}</div>
  if (id === 'mail') return <div>{data.mail?.slice(0, 4).map((item) => <p key={item.id}><strong>{item.subject || '(No subject)'}</strong><br/>{item.sender}</p>)}{!data.mail?.length && <Empty>No imported mail yet.</Empty>}</div>
  return <div>{data.activity?.slice(0, 6).map((item) => <p key={item.id}>{item.event_kind} · {new Date(item.occurred_at).toLocaleString()}</p>)}{!data.activity?.length && <Empty>No recorded activity yet.</Empty>}</div>
}

export type HomeWidgetProps = {
  id: WidgetId; span: number; index: number; count: number; editing: boolean
  focus: FocusTimer; data: HomeData; onToggleTask: (task: TaskOut) => void
  onMove: (delta: -1 | 1) => void; onRemove: () => void; frame: WidgetFrameControls
}

export function HomeWidget({ id, span, index, count, editing, focus, data, onToggleTask, onRemove, frame }: HomeWidgetProps) {
  const def = WIDGET_CATALOG[id]
  const { c, soft } = accentOf(def.color)
  const dark = id === 'weather'
  const doneCount = data.tasks.filter(completed).length
  const badge = id === 'today' && data.tasks.length ? String(Math.max(0, data.tasks.length - doneCount)) : ''
  const style: CSSProperties = {
    background: dark ? 'linear-gradient(180deg,rgba(30,34,60,.30),rgba(20,22,40,.72)),url("/backgrounds/weather/08_evening_sunset.jpg") 82% 40%/auto 420px' : 'var(--glass-bg, rgba(255,255,255,.88))',
    color: dark ? '#fff' : '#1C1B22',
    border: '1px solid rgba(255,255,255,.35)',
  }
  const Icon = def.icon
  return <WidgetFrame controls={frame} style={style} editing={editing} onRemove={onRemove} canMoveEarlier={index > 0} canMoveLater={index < count - 1}>
    <div data-widget-heading="" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, marginBottom: 10 }}>
      <span style={{ width: 28, height: 28, flex: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: dark ? 'rgba(255,255,255,.22)' : soft, color: dark ? '#fff' : c }}><Icon size={16} /></span>
      <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.title}</span>
      {badge && <span style={{ minWidth: 22, height: 20, padding: '0 6px', borderRadius: 10, background: '#F1EDEA', fontSize: 12, fontWeight: 600, lineHeight: '20px', textAlign: 'center' }}>{badge}</span>}
      <span style={{ flex: 1 }} />
      {!editing && def.link && <button type="button" className="home-btn home-link" onClick={def.link.route ? () => navigate(def.link!.route!) : undefined}>{def.link.label}<ChevronRight size={16} /></button>}

    </div>
    <div className="home-widget-body" inert={editing || undefined}><WidgetBody id={id} span={span} focus={focus} data={data} onToggleTask={onToggleTask} /></div>
  </WidgetFrame>
}
