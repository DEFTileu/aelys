// One layout per widget size. Only fields that exist in HomeData are rendered; missing data omits the element.
import { useState, type FormEvent, type ReactNode } from 'react'
import { ChevronRight, Pause, Play, Plus, RotateCcw, Check } from '../../icons'
import type { FocusOut, TaskOut } from '@aelys/shared'
import { FOCUS_SESSION_SECONDS, accentOf } from '../../data/desktop/home'
import { ageLabel, dayLabel } from '../../lib/format'
import { formatMoney, sumDecimals } from '../../lib/money'
import { navigate } from '../../lib/router'
import { WeatherCard } from '../../components/Weather'
import type { RoutePath } from '../../types'
import type { SizeKey, WidgetId } from './homeLayout'
import type { FocusTimer, HomeData } from './homeWidgets'

const pad = (value: number) => String(value).padStart(2, '0')
const hhmm = (value: string | Date | null) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
export const isDone = (task: TaskOut) => ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
const dayStart = (offset = 0) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + offset); return date.getTime() }
const due = (task: TaskOut) => task.due_at ? Date.parse(task.due_at) : Number.POSITIVE_INFINITY
const excerpt = (body: string, max = 140) => body.replace(/[#>*_`\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
const senderName = (sender: string) => sender.replace(/<.*?>/g, '').trim() || sender

export type BodyProps = {
  id: WidgetId; size: SizeKey; mobile: boolean; focus: FocusTimer; data: HomeData
  onToggleTask: (task: TaskOut) => void; onAddTask: (title: string) => Promise<boolean>
}

export function Empty({ text, action }: { text: string; action?: { label: string; route: RoutePath } }) {
  return <div className="wb-empty"><span>{text}</span>{action && <button type="button" className="home-btn wb-action" onClick={() => navigate(action.route)}>{action.label}</button>}</div>
}
export function Failed({ onRetry }: { onRetry: () => void }) {
  return <div className="wb-empty"><span>Can’t load</span><button type="button" className="home-btn wb-action" onClick={onRetry}>Retry</button></div>
}
const Bar = ({ pct, color }: { pct: number; color: string }) => <div className="wb-bar"><div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></div>
const Group = ({ children, tone }: { children: ReactNode; tone?: 'late' }) => <div className={`wb-group${tone ? ` wb-group--${tone}` : ''}`}>{children}</div>
const Footer = ({ children }: { children: ReactNode }) => <div className="wb-foot">{children}</div>

function TaskRow({ task, onToggle, late }: { task: TaskOut; onToggle: (task: TaskOut) => void; late?: boolean }) {
  const checked = isDone(task)
  return <div className="home-task-row wb-row">
    <button type="button" role="checkbox" aria-checked={checked} aria-label={task.title} className={`home-btn wb-check${checked ? ' wb-check--on' : ''}`} onClick={() => onToggle(task)}>{checked && <Check size={12} />}</button>
    <span className={`wb-grow${checked ? ' wb-done' : ''}`}>{task.title}</span>
    {task.due_at && <span className={`wb-muted${late ? ' wb-late' : ''}`}>{late ? dayLabel(task.due_at) : hhmm(task.due_at)}</span>}
  </div>
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => Promise<boolean> }) {
  const [title, setTitle] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); const value = title.trim(); if (value && await onAdd(value)) setTitle('') }
  return <form className="wb-quickadd" onSubmit={event => void submit(event)}><Plus size={16} /><input value={title} onChange={event => setTitle(event.target.value)} placeholder="Add a task" aria-label="Add a task" /></form>
}

function Today({ size, data, onToggleTask, onAddTask }: BodyProps) {
  const tasks = data.tasks
  if (!tasks.length && size !== 'L') return <Empty text="No tasks yet." action={{ label: 'Add task', route: '/tasks' }} />
  const open = tasks.filter(task => !isDone(task)).sort((a, b) => due(a) - due(b))
  if (size === 'S') {
    const next = open[0]
    return <div className="wb-col">
      <div className="wb-big"><b>{open.length}</b><span>of {tasks.length} left</span></div>
      <Bar pct={tasks.length ? (tasks.length - open.length) / tasks.length * 100 : 0} color={accentOf('blue').c} />
      <div className="wb-flex" />
      {next ? <><small className="wb-muted">Next</small><div className="wb-row"><span className="wb-grow wb-strong">{next.title}</span>{next.due_at && <span className="wb-muted">{hhmm(next.due_at)}</span>}</div></> : <small className="wb-muted">All done</small>}
    </div>
  }
  if (size === 'L') {
    const today = dayStart(), tomorrow = dayStart(1), after = dayStart(2)
    const groups: { label: string; tone?: 'late'; items: TaskOut[] }[] = [
      { label: 'Overdue', tone: 'late', items: open.filter(task => due(task) < today) },
      { label: 'Today', items: tasks.filter(task => !task.due_at || (due(task) >= today && due(task) < tomorrow)) },
      { label: 'Tomorrow', items: tasks.filter(task => due(task) >= tomorrow && due(task) < after) },
      { label: 'Later', items: open.filter(task => due(task) >= after && Number.isFinite(due(task))) },
    ]
    return <div className="wb-col">
      <QuickAdd onAdd={onAddTask} />
      {groups.filter(group => group.items.length).map(group => <div key={group.label}><Group tone={group.tone}>{group.label}</Group>{group.items.map(task => <TaskRow key={task.id} task={task} onToggle={onToggleTask} late={group.tone === 'late'} />)}</div>)}
      {!tasks.length && <Empty text="No tasks yet." />}
    </div>
  }
  const rows = [...open, ...tasks.filter(isDone)].slice(0, size === 'Tall' ? 8 : 4)
  return <div>{rows.map(task => <TaskRow key={task.id} task={task} onToggle={onToggleTask} />)}</div>
}

const eventLabel = (event: HomeData['events'][number]) => `${hhmm(event.starts_at)} – ${hhmm(event.ends_at)}`
function countdown(start: number, end: number, now: number) {
  if (start <= now && end > now) return 'Now'
  const minutes = Math.ceil((start - now) / 60000)
  return minutes < 60 ? `In ${minutes} min` : `In ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

function MonthGrid() {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const cells = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)]
  return <div className="wb-month" aria-label={now.toLocaleDateString('en', { month: 'long', year: 'numeric' })}>
    {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={index} className="wb-muted">{day}</span>)}
    {cells.map((day, index) => <span key={index} className={day === now.getDate() ? 'wb-today' : undefined}>{day}</span>)}
  </div>
}

function Calendar({ size, data }: BodyProps) {
  const now = Date.now()
  const events = [...data.events].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
  const upcoming = events.filter(event => Date.parse(event.ends_at) > now)
  if (!events.length && size !== 'L') return <Empty text="No events today." action={{ label: 'Open calendar', route: '/calendar' }} />
  if (size === 'S') {
    const next = upcoming[0]
    if (!next) return <Empty text="Nothing more today." action={{ label: 'Open calendar', route: '/calendar' }} />
    const then = upcoming[1]
    return <div className="wb-col">
      <span className="wb-chip">{countdown(Date.parse(next.starts_at), Date.parse(next.ends_at), now)}</span>
      <div className="wb-title">{next.title}</div>
      <small className="wb-muted">{eventLabel(next)}</small>
      <div className="wb-flex" />
      {then && <Footer><span className="wb-tick" />Then: {then.title} · {hhmm(then.starts_at)}</Footer>}
    </div>
  }
  if (size === 'M') {
    const from = Math.min(9, new Date(events[0].starts_at).getHours())
    const to = Math.max(18, new Date(events[events.length - 1].ends_at).getHours() + 1)
    const span = (to - from) * 60
    const minutes = (iso: string | number) => { const date = new Date(iso); return date.getHours() * 60 + date.getMinutes() - from * 60 }
    const lanes: number[] = []
    const placed = events.map(event => { const start = minutes(event.starts_at); const lane = lanes.findIndex(end => end <= start); const index = lane < 0 ? lanes.length : lane; lanes[index] = minutes(event.ends_at); return { event, start, lane: index } })
    const nowPct = (minutes(now)) / span * 100
    const booked = events.reduce((total, event) => total + (Date.parse(event.ends_at) - Date.parse(event.starts_at)), 0) / 60000
    return <div className="wb-timeline">
      <div className="wb-hours" style={{ gridTemplateColumns: `repeat(${to - from},1fr)` }}>{Array.from({ length: to - from }, (_, index) => <span key={index}>{from + index}</span>)}</div>
      <div className="wb-lanes">
        {placed.map(({ event, start, lane }) => <div key={event.id} className="wb-event" style={{ left: `${Math.max(0, start / span * 100)}%`, width: `${Math.max(12, (minutes(event.ends_at) - start) / span * 100)}%`, top: lane * 34, height: 30 }} title={`${event.title} · ${eventLabel(event)}`}>{event.title}</div>)}
        {nowPct >= 0 && nowPct <= 100 && <div className="wb-now" style={{ left: `${nowPct}%` }} />}
      </div>
      <Footer><b>{events.length} {events.length === 1 ? 'event' : 'events'}</b> · {Math.floor(booked / 60)}h {Math.round(booked % 60)}m booked</Footer>
    </div>
  }
  const list = (size === 'Tall' ? upcoming : events).slice(0, size === 'Tall' ? 6 : 5)
  return <div className="wb-col">
    {size === 'L' && <MonthGrid />}
    {size === 'L' && <Group>Today</Group>}
    {list.map(event => <div key={event.id} className="wb-row"><span className="wb-time wb-muted">{hhmm(event.starts_at)}</span><div className="wb-pill"><div className="home-event-title">{event.title}</div><small>{eventLabel(event)}</small></div></div>)}
    {!list.length && <Empty text="No events today." action={{ label: 'Open calendar', route: '/calendar' }} />}
  </div>
}

function Ring({ pct, children }: { pct: number; children: ReactNode }) {
  return <div className="home-focus-ring" style={{ borderRadius: '50%', background: `conic-gradient(from 0deg,#F9C29A,#F06A58 ${pct}%,#ECE5DF ${pct}%)`, padding: 8 }}><div className="wb-ring-inner">{children}</div></div>
}
const clock = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
function Focus({ size, focus, data }: BodyProps) {
  const pct = Math.min(100, Math.round((focus.left / FOCUS_SESSION_SECONDS) * 100))
  const verb = focus.running ? 'Pause' : focus.paused ? 'Resume' : 'Start'
  const toggle = <><button type="button" className="home-btn home-focus-toggle" disabled={focus.disabled} title={verb} aria-label={`${verb} focus`} onClick={focus.toggle}>{focus.running ? <Pause size={16} /> : <Play size={16} />}</button>
    {focus.live && <button type="button" className="home-btn home-focus-toggle" disabled={focus.disabled} title="Stop" aria-label="Stop focus" onClick={focus.reset}><RotateCcw size={16} /></button>}</>
  const ring = <Ring pct={pct}><div className="home-focus-time">{clock(focus.left)}</div><small className="wb-muted">{focus.paused ? 'Paused' : 'Elapsed focus'}</small></Ring>
  if (size === 'S' || size === 'Tall') return <div className="home-focus-body wb-center">{ring}{toggle}</div>
  const sessions = data.focusSessions ?? []
  const active = sessions.find(item => item.status === 'active' || item.status === 'paused')
  const linked = active?.task_id ? data.tasks.find(task => task.id === active.task_id) : undefined
  const info = <div className="wb-col wb-grow">
    <small className="wb-muted">Linked task</small>
    <div className="wb-strong">{linked?.title ?? 'No task linked'}</div>
    {!focus.live && <div className="wb-presets" aria-label="Duration presets">{[25, 50, 90].map(minutes => <span key={minutes} className="wb-chip">{minutes}</span>)}</div>}
    <div className="wb-actions">{toggle}<button type="button" className="home-btn wb-action" onClick={() => navigate('/timer')}>Open Timer<ChevronRight size={16} /></button></div>
  </div>
  if (size === 'M') return <div className="wb-split">{ring}{info}</div>
  const todayStart = dayStart()
  const seconds = (session: FocusOut) => session.id === active?.id ? focus.left : session.elapsed_seconds
  const today = sessions.filter(session => Date.parse(session.started_at) >= todayStart)
  const week = Array.from({ length: 7 }, (_, index) => { const start = dayStart(index - 6); return { start, total: sessions.filter(session => Date.parse(session.started_at) >= start && Date.parse(session.started_at) < start + 86400000).reduce((sum, session) => sum + seconds(session), 0) } })
  const max = Math.max(1, ...week.map(day => day.total))
  const total = today.reduce((sum, session) => sum + seconds(session), 0)
  return <div className="wb-col">
    <div className="wb-split">{ring}{info}</div>
    <div className="wb-dots" aria-label={`${today.length} sessions today`}>{today.slice(0, 12).map(session => <span key={session.id} className={session.status === 'active' ? 'wb-dot wb-dot--live' : 'wb-dot'} />)}{!today.length && <small className="wb-muted">No sessions today</small>}</div>
    <Footer><b>{Math.floor(total / 3600)}h {Math.floor(total % 3600 / 60)}m</b> focused today</Footer>
    <div className="wb-bars" aria-label="Focus time, last 7 days">{week.map(day => <div key={day.start} title={new Date(day.start).toLocaleDateString('en', { weekday: 'short' })}><i style={{ height: `${Math.max(4, day.total / max * 100)}%` }} /></div>)}</div>
  </div>
}

function Projects({ size, data }: BodyProps) {
  if (!data.projects.length) return <Empty text="No projects yet." action={{ label: 'New project', route: '/projects' }} />
  const ready = data.states?.today === 'ready'
  const stat = (id: string) => { const own = data.tasks.filter(task => task.project_id === id); return { own, pct: own.length ? Math.round(own.filter(isDone).length / own.length * 100) : 0 } }
  if (size === 'S') {
    const project = data.projects[0]; const { own, pct } = stat(project.id)
    return <div className="wb-center wb-col"><Ring pct={ready && own.length ? pct : 0}><b className="wb-ringpct">{ready && own.length ? `${pct}%` : '—'}</b></Ring><div className="wb-strong wb-ellipsis">{project.name}</div></div>
  }
  const limit = size === 'M' ? 3 : size === 'Tall' ? 5 : 4
  return <div className="wb-col">{data.projects.slice(0, limit).map(project => {
    const { own, pct } = stat(project.id); const next = size === 'L' ? own.filter(task => !isDone(task)).sort((a, b) => due(a) - due(b))[0] : undefined
    return <div key={project.id} className="wb-proj"><div className="wb-row"><span className="wb-grow wb-strong wb-ellipsis">{project.name}</span><span className="wb-muted">{ready && own.length ? `${pct}%` : project.status}</span></div>{ready && own.length > 0 && <Bar pct={pct} color={accentOf('violet').c} />}{size === 'L' && <small className="wb-muted wb-ellipsis">{next ? `Next: ${next.title}` : own.length ? 'Nothing left' : 'No tasks yet'}</small>}</div>
  })}</div>
}

function Notes({ id, size, data }: BodyProps) {
  const route: RoutePath = id === 'kb' ? '/knowledge' : '/notes'
  const notes = [...data.notes].sort((a, b) => Date.parse((b as { updated_at?: string }).updated_at ?? '') - Date.parse((a as { updated_at?: string }).updated_at ?? '') || 0)
  if (!notes.length) return <Empty text="No notes yet." action={{ label: 'New note', route }} />
  const card = (note: typeof notes[number], lines = 3) => <button type="button" key={note.id} className="home-btn home-note-row wb-note" onClick={() => navigate(route)}><strong>{note.title || 'Untitled'}</strong><small style={{ WebkitLineClamp: lines }}>{excerpt(note.markdown_body) || 'Empty note'}</small>{(note as { updated_at?: string }).updated_at && <time className="wb-muted" dateTime={(note as { updated_at?: string }).updated_at}>{ageLabel((note as { updated_at?: string }).updated_at!)}</time>}</button>
  if (size === 'S') return card(notes[0], 5)
  if (size === 'M') return <div className="wb-cards">{notes.slice(0, 2).map(note => card(note, 4))}</div>
  const count = size === 'Tall' ? 3 : 5
  return <div className="wb-col">{notes.slice(0, count).map(note => card(note, 2))}{size === 'L' && <button type="button" className="home-btn wb-action" onClick={() => navigate(route)}><Plus size={16} />New</button>}</div>
}

function Finances({ size, data }: BodyProps) {
  if (!data.finance.length) return <Empty text="No transactions yet." action={{ label: 'Add transaction', route: '/finance' }} />
  const counts = new Map<string, number>(); data.finance.forEach(item => counts.set(item.currency, (counts.get(item.currency) ?? 0) + 1))
  const currencies = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([currency]) => currency)
  const primary = currencies[0]
  const items = data.finance.filter(item => item.currency === primary)
  const total = formatMoney(sumDecimals(items.map(item => item.amount)))
  const week = items.filter(item => Date.parse(item.occurred_at) >= dayStart(-6))
  const delta = sumDecimals(week.map(item => item.amount))
  const sign = delta > 0n ? '+' : ''
  const head = <><div className={`wb-big wb-money${total.length > 10 ? ' wb-money--long' : ''}`}><b>{total}</b><span>{primary}</span></div><small className={delta < 0n ? 'wb-late' : 'wb-muted'}>{sign}{formatMoney(delta)} {primary} this week</small></>
  const others = currencies.length > 1 && <small className="wb-muted">+{currencies.length - 1} more {currencies.length === 2 ? 'currency' : 'currencies'} in Finances</small>
  if (size === 'S' || size === 'Tall') return <div className="wb-col">{head}<div className="wb-flex" />{others}</div>
  const days = Array.from({ length: 7 }, (_, index) => { const start = dayStart(index - 6); return { start, units: Number(items.filter(item => Date.parse(item.occurred_at) >= start && Date.parse(item.occurred_at) < start + 86400000).reduce((sum, item) => sum + (sumDecimals([item.amount]) < 0n ? -sumDecimals([item.amount]) : sumDecimals([item.amount])), 0n)) } })
  const max = Math.max(1, ...days.map(day => day.units))
  const bars = <div className="wb-bars" aria-label="Activity, last 7 days">{days.map(day => <div key={day.start} title={new Date(day.start).toLocaleDateString('en', { weekday: 'short' })}><i style={{ height: `${Math.max(4, day.units / max * 100)}%` }} /></div>)}</div>
  if (size === 'M') return <div className="wb-col">{head}{bars}{others}</div>
  const types = [...new Set(items.map(item => item.type))]
  return <div className="wb-col">{head}{bars}<Group>By type</Group>{types.map(type => <div key={type} className="wb-row"><span className="wb-grow">{type}</span><b>{formatMoney(sumDecimals(items.filter(item => item.type === type).map(item => item.amount)))} {primary}</b></div>)}{others}</div>
}

function MailBody({ size, data }: BodyProps) {
  const mail = data.mail ?? []
  if (!mail.length) return <Empty text="No imported mail yet." action={{ label: 'Open Mail', route: '/mail' }} />
  const row = (item: typeof mail[number], preview: boolean) => <button className="home-btn home-mail-row wb-mailrow" type="button" key={item.id} onClick={() => navigate('/mail')}><span className="home-mail-avatar">{senderName(item.sender)[0]?.toUpperCase()}</span><span className="wb-grow"><strong>{senderName(item.sender)}</strong><small>{item.subject || '(No subject)'}</small>{preview && <small className="wb-clamp">{excerpt(item.body, 90)}</small>}</span><time className="wb-muted">{ageLabel(item.received_at)}</time></button>
  if (size === 'S') return <div className="wb-col"><div className="wb-big"><b>{mail.length}</b><span>recent</span></div><div className="wb-avatars">{mail.slice(0, 4).map(item => <span key={item.id} className="home-mail-avatar">{senderName(item.sender)[0]?.toUpperCase()}</span>)}</div></div>
  const count = size === 'M' ? 3 : size === 'Tall' ? 5 : 6
  return <div className="wb-col">{mail.slice(0, count).map(item => row(item, size === 'L'))}</div>
}

function Activity({ size, data }: BodyProps) {
  const items = data.activity ?? []
  if (!items.length) return <Empty text="No recorded activity yet." />
  const count = size === 'S' ? 1 : size === 'M' ? 3 : size === 'Tall' ? 6 : 8
  return <div className="home-activity wb-col">{items.slice(0, count).map(item => <div key={item.id} className="wb-row"><span className="wb-grow"><strong>{item.event_kind.replace(/[._]/g, ' ')}</strong><small>{item.actor_kind}</small></span><time className="wb-muted">{ageLabel(item.occurred_at)}</time></div>)}</div>
}

export function WidgetBody(props: BodyProps & { onRetry: () => void }) {
  const { id, size, data, onRetry } = props
  const state = data.states?.[id]
  if (state === 'loading') return <div className="wb-empty"><span>Loading…</span></div>
  if (state && state !== 'ready') return <Failed onRetry={onRetry} />
  switch (id) {
    case 'today': return <Today {...props} />
    case 'cal': return <Calendar {...props} />
    case 'focus': return <Focus {...props} />
    case 'weather': return <WeatherCard size={size} />
    case 'proj': return <Projects {...props} />
    case 'notes': case 'kb': return <Notes {...props} />
    case 'fin': return <Finances {...props} />
    case 'mail': return <MailBody {...props} />
    default: return <Activity {...props} />
  }
}
