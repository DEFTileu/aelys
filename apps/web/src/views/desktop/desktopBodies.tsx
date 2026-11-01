// Desktop card bodies drawn like the reference design. S and Tall use one column, M and L use two; Tall and L add rows.
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { CloudDrizzle, CloudUpload } from 'lucide-react'
import { Calendar, Check, ChevronDown, Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, FileText, Folder, MapPin, Mail, Moon, Pause, Play, Plus, Sun, Zap, Square, type AelysIconComponent } from '../../icons'
import type { ActivityEvent, FocusOut, MailMessage, NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { ACCENT, FOCUS_SESSION_SECONDS, accentOf, type AccentKey } from '../../data/desktop/home'
import { ageLabel, dayLabel } from '../../lib/format'
import { formatMoney, sumDecimals } from '../../lib/money'
import { navigate } from '../../lib/router'
import { getPrefs, usePrefs } from '../../lib/prefs'
import { openWeatherSettings, refreshWeather, useWeather, weatherDescription } from '../../lib/weather'
import type { RoutePath } from '../../types'
import type { SizeKey } from './homeLayout'
import type { BodyProps } from './widgetBodies'
import { isDone } from './widgetBodies'
import './home-desktop.css'

const pad = (value: number) => String(value).padStart(2, '0')
const hhmm = (value: string | Date) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const dayStart = (offset = 0) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + offset); return date.getTime() }
const due = (task: TaskOut) => task.due_at ? Date.parse(task.due_at) : Number.POSITIVE_INFINITY
const excerpt = (body: string, max = 90) => body.replace(/[#>*_`\-[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
const senderName = (sender: string) => sender.replace(/<.*?>/g, '').trim() || sender
const tall = (size: SizeKey) => size === 'L' || size === 'Tall'
/** Columns inside a card: S and Tall are one column wide, everything else two. */
export const columnsOf = (size: SizeKey) => size === 'S' || size === 'Tall' ? 1 : 2
const soft = (key: AccentKey) => `${ACCENT[key]}1A`
const tile = (key: AccentKey): CSSProperties => ({ background: soft(key), color: accentOf(key).ink })
const cycle = <T,>(items: readonly T[], index: number) => items[index % items.length]!

function Empty({ text, action }: { text: string; action?: { label: string; route: RoutePath } }) {
  return <div className="dw-empty"><span>{text}</span>{action && <button type="button" className="home-btn dw-action" onClick={() => navigate(action.route)}>{action.label}</button>}</div>
}

/** Open tasks due today, overdue or undated, plus what was finished today, in time order. */
export function dayTasks(tasks: readonly TaskOut[]): TaskOut[] {
  const start = dayStart(); const end = dayStart(1)
  const today = (value: number) => value >= start && value < end
  const show = (task: TaskOut) => isDone(task)
    ? (task.completed_at ? today(Date.parse(task.completed_at)) : task.due_at ? today(due(task)) : true)
    : !task.due_at || due(task) < end
  return tasks.filter(show).sort((a, b) => due(a) - due(b))
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => Promise<boolean> }) {
  const [title, setTitle] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); const value = title.trim(); if (value && await onAdd(value)) setTitle('') }
  return <form className="dw-quickadd" onSubmit={(event) => void submit(event)}><Plus size={16} aria-hidden="true" /><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a task" aria-label="Add a task" /></form>
}

function Today({ size, data, onToggleTask, onAddTask }: BodyProps) {
  const list = dayTasks(data.tasks)
  if (!list.length && !tall(size)) return <Empty text="Nothing due today." action={{ label: 'Add task', route: '/tasks' }} />
  const start = dayStart()
  return <div className="dw-tasks">
    {tall(size) && <QuickAdd onAdd={onAddTask} />}
    {list.slice(0, tall(size) ? 11 : 5).map((task) => {
      const checked = isDone(task)
      return <div key={task.id} className="home-task-row dw-task">
        <button type="button" role="checkbox" aria-checked={checked} aria-label={task.title} className={`home-btn dw-check${checked ? ' dw-check--on' : ''}`} onClick={() => onToggleTask(task)}>{checked && <Check size={12} aria-hidden="true" />}</button>
        <span className={`dw-grow${checked ? ' dw-done' : ''}`}>{task.title}</span>
        {task.due_at && <span className="dw-time">{due(task) < start ? dayLabel(task.due_at) : hhmm(task.due_at)}</span>}
      </div>
    })}
    {!list.length && <Empty text="Nothing due today." />}
  </div>
}

const TINTS = [['var(--dw-tint-0)', '#4A8EF0'], ['var(--dw-tint-1)', '#8B6CF0'], ['var(--dw-tint-2)', '#F07362'], ['var(--dw-tint-3)', '#36BE8A'], ['var(--dw-tint-4)', '#EFB23E']] as const

function MonthGrid() {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const cells = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)]
  return <div className="wb-month dw-month" aria-label={now.toLocaleDateString('en', { month: 'long', year: 'numeric' })}>
    {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={index} className="wb-muted">{day}</span>)}
    {cells.map((day, index) => <span key={index} className={day === now.getDate() ? 'wb-today' : undefined}>{day}</span>)}
  </div>
}

function CalendarBody({ size, data }: BodyProps) {
  const events = [...data.events].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
  if (!events.length && size !== 'L') return <Empty text="No events today." action={{ label: 'Open calendar', route: '/calendar' }} />
  const limit = size === 'Tall' ? 8 : size === 'L' ? 4 : 4
  return <div>
    {size === 'L' && <MonthGrid />}
    <div className="dw-cal">
      {events.slice(0, limit).map((event, index) => {
        const [bg, border] = cycle(TINTS, index)
        return <div key={event.id} className="dw-ev"><span className="dw-ev-time">{hhmm(event.starts_at)}</span><div className="dw-ev-pill" style={{ background: bg, borderLeftColor: border }}><div className="dw-ev-title">{event.title}</div><div className="dw-ev-range">{hhmm(event.starts_at)} – {hhmm(event.ends_at)}</div></div></div>
      })}
      {!events.length && <Empty text="No events today." action={{ label: 'Open calendar', route: '/calendar' }} />}
    </div>
  </div>
}

const clock = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
function FocusBody({ size, focus, data }: BodyProps) {
  const pct = Math.min(100, Math.round((focus.left / FOCUS_SESSION_SECONDS) * 100))
  const verb = focus.running ? 'Pause' : focus.paused ? 'Resume' : 'Start'
  const ring = <div className="dw-ring" style={{ background: `conic-gradient(from 0deg,#F9C29A,#F06A58 ${pct}%,var(--dw-ring-track) ${pct}%)` }}><div className="dw-ring-inner"><div className="dw-ring-time">{clock(focus.left)}</div><div className="dw-ring-sub">{focus.paused ? 'Paused' : 'Deep work'}</div></div></div>
  const controls = <div className="dw-ctrls">
    <button type="button" className="home-btn dw-round dw-round--go" disabled={focus.disabled} title={verb} aria-label={`${verb} focus`} onClick={focus.toggle}>{focus.running ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}</button>
    <button type="button" className="home-btn dw-round" disabled={focus.disabled} title="Stop" aria-label="Stop focus" onClick={focus.reset}><Square size={12} aria-hidden="true" /></button>
    <button type="button" className="home-btn dw-select" title="Open Timer" aria-label="Open Timer" onClick={() => navigate('/timer')}>Work<ChevronDown size={16} aria-hidden="true" /></button>
  </div>
  const sessions = data.focusSessions ?? []
  const active = sessions.find((item) => item.status === 'active' || item.status === 'paused')
  const linked = active?.task_id ? data.tasks.find((task) => task.id === active.task_id) : undefined
  const todayStart = dayStart()
  const seconds = (session: FocusOut) => session.id === active?.id ? focus.left : session.elapsed_seconds
  const today = sessions.filter((session) => Date.parse(session.started_at) >= todayStart)
  const total = today.reduce((sum, session) => sum + seconds(session), 0)
  const week = Array.from({ length: 7 }, (_, index) => { const start = dayStart(index - 6); return { start, total: sessions.filter((session) => Date.parse(session.started_at) >= start && Date.parse(session.started_at) < start + 86_400_000).reduce((sum, session) => sum + seconds(session), 0) } })
  const max = Math.max(1, ...week.map((day) => day.total))
  return <div>
    <div className={`dw-focus${columnsOf(size) === 2 ? ' dw-focus--row' : ''}`}>{ring}{controls}</div>
    {tall(size) && <div className="dw-focus-extra">
      <div className="dw-focus-line">Linked task: <b>{linked?.title ?? 'none'}</b></div>
      <div className="dw-focus-line"><b>{Math.floor(total / 3600)}h {Math.floor(total % 3600 / 60)}m</b> focused today · {today.length} {today.length === 1 ? 'session' : 'sessions'}</div>
      <div className="wb-bars" aria-label="Focus time, last 7 days">{week.map((day) => <div key={day.start} title={new Date(day.start).toLocaleDateString('en', { weekday: 'short' })}><i style={{ height: `${Math.max(4, day.total / max * 100)}%` }} /></div>)}</div>
    </div>}
  </div>
}

function WeatherIcon({ code, day = true, size = 16 }: { code: number; day?: boolean; size?: number }) {
  if (code >= 51 && code <= 57) return <CloudDrizzle size={size} aria-hidden="true" />
  const Icon: AelysIconComponent = code === 0 ? day ? Sun : Moon : code <= 2 ? CloudSun : code <= 3 ? Cloud : code <= 48 ? CloudFog : code <= 67 ? CloudRain : code <= 77 ? CloudSnow : code <= 82 ? CloudRain : code <= 86 ? CloudSnow : CloudLightning
  return <Icon size={size} aria-hidden="true" />
}
// Reads the unit at render time; WeatherBody subscribes through usePrefs so a change re-renders it.
const inUnits = (celsius: number) => getPrefs().units === 'f' ? celsius * 9 / 5 + 32 : celsius
const degrees = (celsius: number) => { const value = getPrefs().units === 'f' ? celsius * 9 / 5 + 32 : celsius; return `${value > 0 ? '+' : ''}${Math.round(value)}°` }

function WeatherBody({ size }: BodyProps) {
  const { location, forecast, status } = useWeather()
  usePrefs()
  if (!location) return <div className="dw-empty"><button type="button" className="home-btn dw-action" onClick={openWeatherSettings}><MapPin size={16} aria-hidden="true" />Set location</button></div>
  if (!forecast) return status === 'loading' ? <p role="status" className="dw-weather">Loading weather…</p> : <div className="dw-empty"><span>Can’t load</span><button type="button" className="home-btn dw-action" onClick={() => void refreshWeather(true)}>Retry</button></div>
  // Next hours every two hours, then tomorrow, matching the design's four columns.
  const hours = forecast.hours ?? []
  const columns = [...[0, 2, 4].flatMap((index) => hours[index] ? [{ label: hhmm(new Date(hours[index]!.time.replace('Z', ''))), code: hours[index]!.code, temperature: hours[index]!.temperature, day: true }] : []), ...(forecast.days[1] ? [{ label: new Date(forecast.days[1].date).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }), code: forecast.days[1].code, temperature: forecast.days[1].max, day: true }] : [])]
  return <div className="dw-weather">
    <div className="dw-weather-now"><WeatherIcon code={forecast.code} day={forecast.isDay} size={44} /><div><div className="dw-weather-temp">{degrees(forecast.temperature)}</div><div className="dw-weather-desc">{weatherDescription(forecast.code)}</div></div></div>
    {tall(size) && <div className="dw-weather-days">{forecast.days.slice(0, 5).map((day) => <div key={day.date}><span>{new Date(day.date).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' })}</span><WeatherIcon code={day.code} size={16} /><span>{Math.round(inUnits(day.max))}° / {Math.round(inUnits(day.min))}°</span></div>)}</div>}
    <div className="dw-weather-hours">{columns.map((column) => <div key={column.label}><span>{column.label}</span><WeatherIcon code={column.code} day={column.day} /><b>{degrees(column.temperature)}</b></div>)}</div>
  </div>
}

const projectColors: AccentKey[] = ['violet', 'blue', 'green']
function ProjectsBody({ size, data }: BodyProps) {
  if (!data.projects.length) return <Empty text="No projects yet." action={{ label: 'New project', route: '/projects' }} />
  const ready = data.states?.today === 'ready'
  const stat = (project: ProjectResponse) => { const own = data.tasks.filter((task) => task.project_id === project.id); return { count: own.length, pct: own.length ? Math.round(own.filter(isDone).length / own.length * 100) : 0 } }
  return <div className="dw-grid dw-proj" style={{ '--dw-cols': columnsOf(size) } as CSSProperties}>
    {data.projects.slice(0, tall(size) ? 8 : 3).map((project, index) => {
      const { count, pct } = stat(project); const key = cycle(projectColors, index)
      return <div key={project.id} className="dw-proj-item"><span className="dw-tile" style={tile(key)}><Folder size={18} aria-hidden="true" /></span><div className="dw-proj-main"><div className="dw-proj-line"><span>{project.name}</span><span>{ready ? `${pct}%` : ''}</span></div><div className="dw-proj-sub">{ready ? `${count} ${count === 1 ? 'task' : 'tasks'}` : project.status}</div><div className="dw-proj-bar"><div style={{ width: `${ready ? pct : 0}%`, background: ACCENT[key] }} /></div></div></div>
    })}
  </div>
}

const noteColors: AccentKey[] = ['blue', 'violet', 'orange', 'red']
function NotesBody({ id, size, data }: BodyProps) {
  const route: RoutePath = id === 'kb' ? '/knowledge' : '/notes'
  const updated = (note: NoteOut) => Date.parse(note.updated_at ?? '') || 0
  const notes = [...data.notes].sort((a, b) => (size === 'L' ? Number(!!b.pinned) - Number(!!a.pinned) : 0) || updated(b) - updated(a))
  if (!notes.length) return <Empty text="No notes yet." action={{ label: 'New note', route }} />
  if (id === 'kb') {
    const colors: AccentKey[] = ['green', 'red', 'violet', 'blue']
    return <div className="dw-grid dw-list" style={{ '--dw-cols': columnsOf(size) } as CSSProperties}>{notes.slice(0, tall(size) ? 10 : 4).map((note, index) => <button type="button" key={note.id} className="home-btn dw-row" onClick={() => navigate(route)}><span className="dw-tile" style={tile(cycle(colors, index))}><FileText size={16} aria-hidden="true" /></span><div className="dw-row-main"><div className="dw-row-title">{note.title || 'Untitled'}</div><div className="dw-row-sub">{note.updated_at ? `Updated ${ageLabel(note.updated_at)}` : excerpt(note.markdown_body, 40)}</div></div></button>)}</div>
  }
  return <div className="dw-grid dw-notes" style={{ '--dw-cols': columnsOf(size) } as CSSProperties}>{notes.slice(0, tall(size) ? 10 : 4).map((note, index) => <button type="button" key={note.id} className="home-btn dw-note" onClick={() => navigate(route)}><span className="dw-tile" style={tile(cycle(noteColors, index))}><FileText size={16} aria-hidden="true" /></span><span className="dw-grow">{note.title || 'Untitled'}</span>{note.updated_at && <span className="dw-note-when">{ageLabel(note.updated_at)}</span>}</button>)}</div>
}

const spendColors = ['#EA6A1A', '#2F6FE4', '#6A4CF2', '#D9367E']
const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
/** 48250.00 -> "48 250"; fractions only appear when they are not zero. */
function money(units: bigint, currency: string) {
  const [whole = '0', fraction = ''] = formatMoney(units).split('.')
  const sign = whole.startsWith('-') ? '-' : ''
  const symbol = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
  return `${sign}${groupThousands(whole.replace('-', ''))}${/[1-9]/.test(fraction) ? `.${fraction.replace(/0+$/, '')}` : ''} ${symbol}`
}

function FinanceBody({ size, data }: BodyProps) {
  if (!data.finance.length) return <Empty text="No transactions yet." action={{ label: 'Add transaction', route: '/finance' }} />
  const counts = new Map<string, number>(); data.finance.forEach((item) => counts.set(item.currency, (counts.get(item.currency) ?? 0) + 1))
  const currencies = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([currency]) => currency)
  const primary = currencies[0]!
  const items = data.finance.filter((item) => item.currency === primary)
  const total = sumDecimals(items.map((item) => item.amount))
  const delta = sumDecimals(items.filter((item) => Date.parse(item.occurred_at) >= dayStart(-6)).map((item) => item.amount))
  const days = Array.from({ length: 7 }, (_, index) => { const start = dayStart(index - 6); return Number(items.filter((item) => Date.parse(item.occurred_at) >= start && Date.parse(item.occurred_at) < start + 86_400_000).reduce((sum, item) => { const units = sumDecimals([item.amount]); return sum + (units < 0n ? -units : units) }, 0n)) })
  const max = Math.max(1, ...days)
  const spent = (item: typeof items[number]) => { const units = sumDecimals([item.amount]); return units < 0n ? -units : units }
  const expenses = items.filter((item) => item.type === 'expense')
  const byCategory = new Map<string, bigint>(); expenses.forEach((item) => { const name = item.category_name || 'Uncategorized'; byCategory.set(name, (byCategory.get(name) ?? 0n) + spent(item)) })
  const categories = [...byCategory.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, tall(size) ? 8 : 4)
  const now = Date.now()
  const budget = (data.budgets ?? []).filter((item) => item.currency === primary && Date.parse(item.period_start) <= now && now < Date.parse(item.period_end)).sort((a, b) => Number(a.category_id !== null) - Number(b.category_id !== null))[0]
  const budgetRow = size === 'L' && budget && (() => {
    const used = expenses.filter((item) => (budget.category_id === null || item.category_id === budget.category_id) && Date.parse(item.occurred_at) >= Date.parse(budget.period_start) && Date.parse(item.occurred_at) < Date.parse(budget.period_end)).reduce((sum, item) => sum + spent(item), 0n)
    const limit = sumDecimals([budget.limit_amount])
    return <div className="dw-fin-budget"><div className="dw-proj-line"><span>Budget</span><span>{money(used, primary)} / {money(limit, primary)}</span></div><div className="dw-proj-bar"><div style={{ width: `${limit > 0n ? Math.min(100, Number(used * 100n / limit)) : 0}%`, background: used > limit ? '#C9302C' : ACCENT.green }} /></div></div>
  })()
  return <div>
    <div className="dw-fin-head"><div><div className="dw-fin-total">{money(total, primary)}</div><div className={`dw-fin-delta${delta < 0n ? ' dw-fin-delta--down' : ''}`}>{delta > 0n ? '+' : ''}{money(delta, primary)} this week</div></div><div className="dw-fin-bars" aria-label="Activity, last 7 days">{days.map((units, index) => <span key={index} style={{ height: Math.max(4, Math.round(units / max * 32)) }} />)}</div></div>
    {categories.map(([name, units], index) => <div key={name} className="dw-fin-row"><span style={{ background: cycle(spendColors, index) }} /><span>{name}</span><span>{money(units, primary)}</span></div>)}
    {budgetRow}
    {currencies.length > 1 && <div className="dw-fin-budget dw-time">+{currencies.length - 1} more {currencies.length === 2 ? 'currency' : 'currencies'} in Finances</div>}
  </div>
}

const mailColors: AccentKey[] = ['blue', 'violet', 'green', 'orange']
function MailBody({ size, data }: BodyProps) {
  const mail = data.mail ?? []
  const unread = mail.filter((item: MailMessage) => item.is_read === false)
  if (!mail.length || (!unread.length && size !== 'L')) return <Empty text="Inbox is clear" action={{ label: 'Import', route: '/mail' }} />
  const rows = size === 'L' ? mail : unread
  return <div className="dw-grid dw-list" style={{ '--dw-cols': columnsOf(size) } as CSSProperties}>{rows.slice(0, tall(size) ? 10 : 4).map((item, index) => <button type="button" key={item.id} className="home-btn dw-row" onClick={() => navigate('/mail')}><span className="dw-tile" style={tile(cycle(mailColors, index))}><Mail size={16} aria-hidden="true" /></span><div className="dw-row-main"><div className="dw-row-title dw-row-title--head"><span>{senderName(item.sender)}</span><span>{ageLabel(item.received_at)}</span></div><div className="dw-row-sub">{item.subject || '(No subject)'}</div></div></button>)}</div>
}

export function DesktopBody(props: BodyProps) {
  switch (props.id) {
    case 'today': return <Today {...props} />
    case 'cal': return <CalendarBody {...props} />
    case 'focus': return <FocusBody {...props} />
    case 'weather': return <WeatherBody {...props} />
    case 'proj': return <ProjectsBody {...props} />
    case 'notes': case 'kb': return <NotesBody {...props} />
    case 'fin': return <FinanceBody {...props} />
    case 'mail': return <MailBody {...props} />
    default: return null
  }
}
