import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import type { TaskOut, ProjectResponse } from '@aelys/shared'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

type TaskTab = 'today' | 'plan' | 'projects' | 'filters'
type TaskFilter = 'all' | 'today' | 'overdue' | 'high' | 'completed'

type TaskProject = {
  readonly id: string
  readonly label: string
  readonly taskCount: number
  readonly completedCount: number
}

const glassStyle: CSSProperties = {
  border: '1px solid rgba(255, 255, 255, .35)',
  borderRadius: 20,
  background: 'rgba(255, 255, 255, .88)',
  boxShadow: '0 8px 24px rgba(40, 30, 30, .07)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
}

const mutedText: CSSProperties = { color: '#625D69' }

function makeOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function dateKey(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayKey(): string {
  return dateKey(new Date().toISOString()) ?? ''
}

function isCompleted(task: TaskOut): boolean {
  return ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
}

function isOverdue(task: TaskOut, now = Date.now()): boolean {
  if (isCompleted(task) || !task.due_at) return false
  const due = new Date(task.due_at).getTime()
  return Number.isFinite(due) && due < now
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date)
}

function priorityLabel(priority: number): string {
  if (priority >= 3) return 'High'
  if (priority === 2) return 'Medium'
  return 'Low'
}

function priorityColor(priority: number): string {
  if (priority >= 3) return '#D93636'
  if (priority === 2) return '#D99024'
  return '#8D8791'
}

function projectLabel(task: TaskOut, projects: ReadonlyMap<string, ProjectResponse>): string | null {
  if (!task.project_id) return null
  return projects.get(task.project_id)?.name ?? 'Linked project'
}

function taskProjectGroups(tasks: readonly TaskOut[], projects: ReadonlyMap<string, ProjectResponse>): readonly TaskProject[] {
  const grouped = new Map<string, TaskProject>()
  for (const task of tasks) {
    if (!task.project_id) continue
    const previous = grouped.get(task.project_id)
    const label = projects.get(task.project_id)?.name ?? 'Linked project'
    grouped.set(task.project_id, {
      id: task.project_id,
      label,
      taskCount: (previous?.taskCount ?? 0) + 1,
      completedCount: (previous?.completedCount ?? 0) + (isCompleted(task) ? 1 : 0),
    })
  }
  return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function TaskRow({ task, projects, onToggle }: { task: TaskOut; projects: ReadonlyMap<string, ProjectResponse>; onToggle: (task: TaskOut) => void }) {
  const completed = isCompleted(task)
  const project = projectLabel(task, projects)
  return <div className="tv-task-row">
    <button className={`tv-check ${completed ? 'tv-check--done' : ''}`} type="button" aria-label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`} aria-pressed={completed} onClick={() => onToggle(task)}>
      {completed && <Icon name="check-square" size={14} strokeWidth={2.2} />}
    </button>
    <Icon name="alert" size={16} style={{ color: priorityColor(task.priority) }} aria-label={`${priorityLabel(task.priority)} priority`} />
    <div className="tv-task-copy">
      <div className="tv-task-title-line"><strong className={completed ? 'tv-task-title--done' : ''}>{task.title}</strong>{project && <span className="tv-project-tag"><Icon name="folder" size={12} />{project}</span>}</div>
      {task.description && <p>{task.description}</p>}
    </div>
    <time dateTime={task.due_at ?? undefined}>{formatTime(task.due_at)}</time>
    <button className="tv-more" type="button" aria-label={`More actions for ${task.title}`} title={`${priorityLabel(task.priority)} priority`}><Icon name="more-horizontal" size={16} /></button>
  </div>
}

function TaskGroup({ title, subtitle, tasks, projects, onToggle }: { title: string; subtitle?: string; tasks: readonly TaskOut[]; projects: ReadonlyMap<string, ProjectResponse>; onToggle: (task: TaskOut) => void }) {
  return <div className="tv-upcoming-group">
    <div className="tv-group-label"><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div>
    {tasks.map((task) => <TaskRow key={task.id} task={task} projects={projects} onToggle={onToggle} />)}
  </div>
}

function QuickFilter({ active, icon, label, count, tone = 'neutral', onClick }: { active: boolean; icon: Parameters<typeof Icon>[0]['name']; label: string; count: number | null; tone?: 'neutral' | 'red' | 'blue'; onClick: () => void }) {
  return <button className={`tv-filter ${active ? 'tv-filter--active' : ''}`} type="button" onClick={onClick}>
    <Icon name={icon} size={16} style={{ color: tone === 'red' ? '#D93636' : tone === 'blue' ? '#2F6FE4' : '#5132D6' }} />
    <span>{label}</span>
    {count !== null && <b className={tone === 'red' ? 'tv-filter-count--red' : ''}>{count}</b>}
  </button>
}

function EmptyTasks({ status, onRetry }: { status: ApiStatus; onRetry: () => void }) {
  const copy = status === 'loading'
    ? ['Loading tasks', 'Checking the connected task source.']
    : status === 'offline'
      ? ['Tasks are offline', 'Reconnect to load the latest task data. Quick filters remain unavailable until task data is available. Previously saved local changes remain governed by the offline queue.']
      : status === 'empty'
        ? ['No tasks yet', 'Create a task or connect a source to see the Tasks workspace.']
      : ['Tasks are unavailable', 'The task API did not respond. Check the connection and try again.']
  return <StateCard status={status} title={copy[0]} description={copy[1]} action={<button className="text-button" type="button" onClick={onRetry}><Icon name="refresh" size={14} />Try again</button>} />
}

export function TasksView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [tasks, setTasks] = useState<readonly TaskOut[]>([])
  const [projects, setProjects] = useState<ReadonlyMap<string, ProjectResponse>>(new Map())
  const [contentStatus, setContentStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [tab, setTab] = useState<TaskTab>('today')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [formOpen, setFormOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [actionMessage, setActionMessage] = useState('')

  const load = async () => {
    if (apiStatus !== 'ready') { setContentStatus(apiStatus); return }
    setContentStatus('loading')
    try {
      const client = getSharedApiClient()
      const [taskResult, projectResult] = await Promise.allSettled([client.tasks(), client.projects()])
      if (taskResult.status === 'rejected') throw taskResult.reason
      setTasks(taskResult.value)
      if (projectResult.status === 'fulfilled') setProjects(new Map(projectResult.value.map((project) => [project.id, project])))
      setContentStatus('ready')
    } catch {
      setContentStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
    }
  }

  useEffect(() => { void load() }, [apiStatus])

  const today = todayKey()
  const todayTasks = useMemo(() => tasks.filter((task) => dateKey(task.due_at) === today), [tasks, today])
  const upcomingTasks = useMemo(() => tasks.filter((task) => {
    const key = dateKey(task.due_at)
    return key !== null && key > today && !isCompleted(task)
  }), [tasks, today])
  const overdueTasks = useMemo(() => tasks.filter((task) => isOverdue(task)), [tasks])
  const completedTasks = useMemo(() => tasks.filter(isCompleted), [tasks])
  const filteredTasks = useMemo(() => {
    if (filter === 'today') return todayTasks
    if (filter === 'overdue') return overdueTasks
    if (filter === 'high') return tasks.filter((task) => task.priority >= 3 && !isCompleted(task))
    if (filter === 'completed') return completedTasks
    return tasks
  }, [completedTasks, filter, overdueTasks, tasks, todayTasks])
  const projectGroups = useMemo(() => taskProjectGroups(tasks, projects), [projects, tasks])
  const displayToday = useMemo(() => {
    if (tab === 'today') return filter === 'all' ? todayTasks : filteredTasks
    if (tab === 'projects') return tasks.filter((task) => task.project_id !== null)
    if (tab === 'plan') return [...tasks].sort((a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999'))
    return filteredTasks
  }, [filter, filteredTasks, tab, tasks, todayTasks])
  const displayUpcoming = filter === 'all' && tab === 'today' ? upcomingTasks : []
  const total = tasks.length
  const completedToday = todayTasks.filter(isCompleted).length
  const inProgressToday = todayTasks.filter((task) => !isCompleted(task) && !isOverdue(task)).length
  const overdueCount = overdueTasks.length
  const statsRatio = total === 0 ? 0 : Math.round((completedTasks.length / total) * 100)

  const selectFilter = (next: TaskFilter) => {
    setFilter(next)
    setTab('filters')
  }

  const toggleTask = async (task: TaskOut) => {
    const nextStatus = isCompleted(task) ? 'open' : 'completed'
    setActionMessage('')
    try {
      await getSharedApiClient().updateTask(task.id, { title: task.title, status: nextStatus })
      await load()
    } catch (error) {
      if (error instanceof OfflineQueuedError) setActionMessage('Saved on this device and queued for sync.')
      else if (error instanceof ApiError) setActionMessage(`${error.code}: ${error.message}`)
      else setActionMessage('Could not update this task.')
    }
  }

  const createTask = async (event: FormEvent) => {
    event.preventDefault()
    const title = newTitle.trim()
    if (!title) return
    setActionMessage('')
    const value = { title }
    try {
      const operationId = makeOperationId()
      await getSharedApiClient().createTask(value, { idempotencyKey: operationId, offlineEntityKey: `pending:tasks:${operationId}`, offlineEntityValue: { pending: true, ...value } })
      setNewTitle('')
      setFormOpen(false)
      await load()
    } catch (error) {
      if (error instanceof OfflineQueuedError) { setNewTitle(''); setFormOpen(false); setActionMessage('Saved on this device and queued for sync.') }
      else if (error instanceof ApiError) setActionMessage(`${error.code}: ${error.message}`)
      else setActionMessage('Could not create this task.')
    }
  }

  return <div className="page tasks-view">
    <style>{`
      .tasks-view { color:#1C1B22; padding-bottom:32px; }
      .tasks-view * { box-sizing:border-box; }
      .tv-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; padding:26px 28px 22px; }
      .tv-eyebrow { margin:0 0 7px; color:#6A4CF2; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      .tv-hero h1 { margin:0; font:600 clamp(30px,4vw,40px)/1.1 Inter,-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif; letter-spacing:-.045em; }
      .tv-hero p { margin:8px 0 0; color:#625D69; font-size:14px; }
      .tv-toolbar { display:flex; align-items:center; gap:12px; padding:0 28px 16px; }
      .tv-tabs { display:flex; gap:2px; padding:4px; border:1px solid #ECE7E3; border-radius:14px; background:rgba(255,255,255,.88); }
      .tv-tab { height:32px; display:flex; align-items:center; gap:7px; padding:0 13px; border:0; border-radius:10px; color:#625D69; background:transparent; cursor:pointer; font-size:13px; }
      .tv-tab--active { color:#5132D6; background:#EEEAFD; font-weight:600; }
      .tv-ai { min-width:180px; flex:1; height:40px; display:flex; align-items:center; gap:9px; padding:0 6px 0 9px; border:1px solid #ECE7E3; border-radius:20px; background:rgba(255,255,255,.88); }
      .tv-ai-orb { width:28px; height:28px; flex:none; border-radius:50%; background:radial-gradient(circle at 32% 28%,#fff 0,rgba(235,225,255,.9) 9%,transparent 28%),radial-gradient(circle at 72% 72%,#FF7AD9 0,transparent 48%),radial-gradient(circle at 24% 72%,#46D2FF 0,transparent 46%),radial-gradient(circle at 50% 50%,#6E4CF2 0,#2A1590 82%); }
      .tv-ai input { min-width:0; flex:1; border:0; outline:0; color:#1C1B22; background:transparent; font-size:14px; }
      .tv-ai input::placeholder { color:#8D8791; }
      .tv-ai button { width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:50%; color:#fff; background:#6A4CF2; cursor:pointer; }
      .tv-new { height:40px; display:flex; align-items:center; gap:8px; padding:0 16px; border:0; border-radius:12px; color:#fff; background:#6A4CF2; box-shadow:0 4px 12px rgba(106,76,242,.3); cursor:pointer; font-size:14px; font-weight:600; white-space:nowrap; }
      .tv-new:hover { background:#5B3DE6; }
      .tv-layout { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:16px; padding:0 28px; }
      .tv-column { display:flex; min-width:0; flex-direction:column; gap:16px; }
      .tv-card { padding:18px; }
      .tv-card-heading { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
      .tv-card-heading h2 { margin:0; font-size:22px; line-height:30px; font-weight:600; letter-spacing:-.025em; }
      .tv-count { min-width:24px; height:22px; display:inline-flex; align-items:center; justify-content:center; padding:0 7px; border-radius:11px; color:#4F4A56; background:#F1EDEA; font-size:12px; font-weight:600; }
      .tv-card-heading > time { margin-left:auto; color:#625D69; font-size:13px; }
      .tv-nav-button { width:32px; height:32px; display:grid; place-items:center; border:0; border-radius:10px; color:#625D69; background:transparent; cursor:pointer; }
      .tv-nav-button:hover,.tv-more:hover { background:#F1EDEA; }
      .tv-task-row { min-height:56px; display:flex; align-items:center; gap:12px; padding:8px; margin:0 -8px; border-bottom:1px solid #F0EBE7; }
      .tv-task-row:hover { border-radius:12px; background:#F7F4F1; }
      .tv-check { width:22px; height:22px; display:grid; flex:none; place-items:center; padding:0; border:2px solid #BDB7C2; border-radius:50%; color:#fff; background:transparent; cursor:pointer; }
      .tv-check--done { border-color:#14966C; background:#14966C; }
      .tv-task-copy { min-width:0; flex:1; }
      .tv-task-title-line { display:flex; align-items:center; gap:8px; min-width:0; }
      .tv-task-title-line strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; line-height:20px; font-weight:500; }
      .tv-task-title--done { color:#8D8791; text-decoration:line-through; }
      .tv-task-copy p { overflow:hidden; margin:2px 0 0; color:#625D69; font-size:13px; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
      .tv-task-row time { width:48px; color:#625D69; font-size:13px; white-space:nowrap; }
      .tv-project-tag { min-width:0; max-width:150px; height:22px; display:inline-flex; align-items:center; gap:4px; overflow:hidden; padding:0 8px; border-radius:11px; color:#5132D6; background:#EEEAFD; font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
      .tv-more { width:32px; height:32px; display:grid; place-items:center; flex:none; border:0; border-radius:10px; color:#625D69; background:transparent; cursor:pointer; }
      .tv-upcoming-group { display:grid; gap:2px; }
      .tv-group-label { padding:6px 10px; border-radius:10px; background:#F4F0EC; font-size:13px; line-height:18px; }
      .tv-group-label span { margin-left:4px; color:#625D69; }
      .tv-filter-card h3,.tv-side-heading { margin:0 0 12px; font-size:16px; line-height:24px; font-weight:600; }
      .tv-filter-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .tv-filter { min-width:0; height:40px; display:flex; align-items:center; gap:8px; padding:0 10px; border:0; border-radius:12px; color:#1C1B22; background:#F7F4F1; cursor:pointer; font-size:13px; text-align:left; }
      .tv-filter:hover,.tv-filter--active { background:#EEEAFD; }
      .tv-filter span { min-width:0; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
      .tv-filter b { min-width:24px; height:20px; display:inline-flex; align-items:center; justify-content:center; padding:0 6px; border-radius:10px; color:#4F4A56; background:rgba(0,0,0,.05); font-size:12px; font-weight:500; }
      .tv-filter b.tv-filter-count--red { color:#C9302C; background:#FDE3E1; }
      .tv-project-list { display:grid; gap:12px; }
      .tv-project { display:flex; align-items:center; gap:12px; }
      .tv-project-icon { width:36px; height:36px; display:grid; flex:none; place-items:center; border-radius:10px; color:#5132D6; background:#EEEAFD; }
      .tv-project-body { min-width:0; flex:1; }
      .tv-project-title { display:flex; gap:8px; font-size:14px; line-height:20px; font-weight:500; }
      .tv-project-title span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tv-project-title span:last-child { color:#625D69; font-size:12px; font-weight:400; }
      .tv-progress { height:4px; margin-top:4px; overflow:hidden; border-radius:2px; background:#ECE7E3; }
      .tv-progress span { display:block; height:100%; border-radius:2px; background:#6A4CF2; }
      .tv-project-meta { margin-top:2px; color:#625D69; font-size:12px; line-height:16px; }
      .tv-stats-heading { display:flex; align-items:center; margin-bottom:12px; }
      .tv-stats-heading h3 { flex:1; margin:0; font-size:16px; line-height:24px; font-weight:600; }
      .tv-stats-heading span { height:32px; display:flex; align-items:center; gap:6px; padding:0 10px; border:1px solid #E7E2DE; border-radius:10px; color:#1C1B22; background:#fff; font-size:13px; }
      .tv-stat-body { display:flex; align-items:center; gap:20px; }
      .tv-ring { width:96px; height:96px; display:grid; flex:none; place-items:center; border-radius:50%; background:conic-gradient(#6A4CF2 0 var(--tv-stat-pct),#E9E3F5 var(--tv-stat-pct) 100%); }
      .tv-ring-inner { width:80px; height:80px; display:flex; flex-direction:column; align-items:center; justify-content:center; border-radius:50%; background:#FDFBFA; }
      .tv-ring-inner b { font-size:20px; line-height:28px; }
      .tv-ring-inner span { color:#625D69; font-size:12px; line-height:16px; }
      .tv-stat-list { display:grid; flex:1; gap:4px; font-size:13px; line-height:18px; }
      .tv-stat-line { display:flex; align-items:center; gap:8px; }
      .tv-stat-line i { width:8px; height:8px; border-radius:50%; background:#1FB58A; }
      .tv-stat-line:nth-child(2) i { background:#3B82F6; }.tv-stat-line:nth-child(3) i { background:#E5484D; }.tv-stat-line:nth-child(4) i { background:#A29DA8; }
      .tv-stat-line span { flex:1; }.tv-stat-line b { font-weight:600; }
      .tv-empty { margin-top:10px; }
      .tv-create { display:flex; gap:8px; align-items:center; padding:10px; margin-bottom:12px; border:1px solid #ECE7E3; border-radius:14px; background:#F7F4F1; }
      .tv-create input { min-width:0; flex:1; height:38px; padding:0 10px; border:1px solid #E7E2DE; border-radius:10px; outline:0; color:#1C1B22; background:#fff; }
      .tv-create button { height:38px; padding:0 12px; border:0; border-radius:10px; color:#fff; background:#6A4CF2; cursor:pointer; font-weight:600; }
      .tv-create button[type=button] { color:#625D69; background:#fff; }
      .tv-message { margin:0 0 12px; color:#128A63; font-size:12px; }
      .tv-api { display:flex; align-items:center; gap:10px; margin:0 28px 14px; }
      @media (max-width: 1050px) { .tv-layout { grid-template-columns:minmax(0,1fr) 300px; padding-inline:20px; }.tv-toolbar,.tv-hero { padding-inline:20px; }.tv-api { margin-inline:20px; } }
      @media (max-width: 760px) { .tv-hero { align-items:flex-start; flex-direction:column; gap:14px; padding:24px 2px 18px; }.tv-toolbar { flex-wrap:wrap; padding-inline:2px; }.tv-tabs { width:100%; overflow:auto; }.tv-tab { flex:1; justify-content:center; padding-inline:8px; }.tv-ai { order:3; width:100%; }.tv-new { margin-left:auto; }.tv-layout { display:flex; flex-direction:column; padding-inline:2px; }.tv-column { gap:12px; }.tv-card { padding:15px; }.tv-card-heading > time { display:none; }.tv-project-tag { max-width:110px; }.tv-api { margin-inline:2px; } }
    `}</style>

    <header className="tv-hero">
      <div><p className="tv-eyebrow">Work queue</p><h1>My tasks</h1><p>More focus. More results.</p></div>
      <ApiStatusPill status={apiStatus} />
    </header>

    <div className="tv-toolbar">
      <div className="tv-tabs" role="tablist" aria-label="Task views">
        {([['today', 'Today', 'calendar'], ['plan', 'Plan', 'calendar'], ['projects', 'Projects', 'folder'], ['filters', 'Filters', 'sliders']] as const).map(([value, label, icon]) => <button key={value} className={`tv-tab ${tab === value ? 'tv-tab--active' : ''}`} type="button" role="tab" aria-selected={tab === value} onClick={() => { setTab(value); if (value === 'today') setFilter('all') }}><Icon name={icon} size={15} />{label}</button>)}
      </div>
      <label className="tv-ai"><span className="tv-ai-orb" /><input aria-label="Ask Aelys about your tasks" placeholder="Ask Aelys about your tasks…" /><button type="button" aria-label="Send task question"><Icon name="arrow-up" size={15} /></button></label>
      <button className="tv-new" type="button" onClick={() => setFormOpen((open) => !open)}><Icon name="plus" size={17} />New task</button>
    </div>

    <div className="tv-api"><ApiStatusPill status={apiStatus} /><span style={mutedText}>Tasks come from the connected API or its durable offline cache.</span></div>
    {formOpen && <form className="tv-create" onSubmit={createTask}><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Name your task" aria-label="New task title" /><button type="submit">Save</button><button type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {actionMessage && <p className="tv-message" role="status">{actionMessage}</p>}

    {contentStatus !== 'ready' ? <div className="tv-empty"><EmptyTasks status={contentStatus} onRetry={() => void load()} /></div> : <div className="tv-layout">
      <div className="tv-column">
        <section className="tv-card" style={glassStyle}>
          <div className="tv-card-heading"><h2>{tab === 'today' ? 'Today' : tab === 'plan' ? 'Plan' : tab === 'projects' ? 'Project tasks' : filter === 'all' ? 'All tasks' : filter === 'completed' ? 'Completed' : 'Filtered tasks'}</h2><span className="tv-count">{displayToday.length}</span><time>{formatDay(today)}</time><button className="tv-nav-button" type="button" aria-label="Previous day"><Icon name="arrow-left" size={16} /></button><button className="tv-nav-button" type="button" aria-label="Next day"><Icon name="chevron-right" size={16} /></button></div>
          {displayToday.length > 0 ? displayToday.map((task) => <TaskRow key={task.id} task={task} projects={projects} onToggle={toggleTask} />) : <StateCard status="empty" title={tasks.length === 0 ? 'No tasks yet' : 'No tasks in this view'} description={tasks.length === 0 ? 'Create a task or connect a source to see it here.' : 'Try another tab or quick filter.'} />}
        </section>
        {displayUpcoming.length > 0 && <section className="tv-card" style={glassStyle}><div className="tv-card-heading"><h2>Upcoming</h2><span className="tv-count">{displayUpcoming.length}</span><span style={{ ...mutedText, marginLeft: 'auto', fontSize: 13 }}>All</span></div><TaskGroup title="Next due" subtitle="" tasks={displayUpcoming} projects={projects} onToggle={toggleTask} /></section>}
      </div>

      <div className="tv-column">
        <section className="tv-card tv-filter-card" style={glassStyle}><h3>Quick filters</h3><div className="tv-filter-grid"><QuickFilter active={filter === 'all'} icon="check-square" label="All tasks" count={total} onClick={() => selectFilter('all')} /><QuickFilter active={filter === 'today'} icon="calendar" label="Today" count={todayTasks.length} tone="red" onClick={() => selectFilter('today')} /><QuickFilter active={filter === 'overdue'} icon="alert" label="Overdue" count={overdueCount} tone="red" onClick={() => selectFilter('overdue')} /><QuickFilter active={filter === 'high'} icon="alert" label="High priority" count={tasks.filter((task) => task.priority >= 3 && !isCompleted(task)).length} tone="red" onClick={() => selectFilter('high')} /><QuickFilter active={filter === 'completed'} icon="check-square" label="Completed" count={completedTasks.length} onClick={() => selectFilter('completed')} /><QuickFilter active={false} icon="lock" label="Assigned to me" count={null} tone="blue" onClick={() => setActionMessage('Assignment data is not part of the current task contract.')} /></div></section>
        <section className="tv-card" style={glassStyle}><div className="tv-stats-heading"><h3>Projects</h3><span>From tasks <Icon name="chevron-right" size={14} /></span></div>{projectGroups.length > 0 ? <div className="tv-project-list">{projectGroups.map((project) => { const percent = Math.round((project.completedCount / project.taskCount) * 100); return <div className="tv-project" key={project.id}><span className="tv-project-icon"><Icon name="folder" size={17} /></span><div className="tv-project-body"><div className="tv-project-title"><span>{project.label}</span><span>{percent}%</span></div><div className="tv-progress"><span style={{ width: `${percent}%` }} /></div><div className="tv-project-meta">{project.completedCount} of {project.taskCount} complete</div></div></div> })}</div> : <StateCard status="empty" title="No linked projects" description="Project progress appears when returned tasks carry a project relationship." />}</section>
        <section className="tv-card" style={glassStyle}><div className="tv-stats-heading"><h3>Statistics</h3><span>Week <Icon name="chevron-right" size={14} /></span></div><div className="tv-stat-body"><div className="tv-ring" style={{ '--tv-stat-pct': `${statsRatio}%` } as CSSProperties}><div className="tv-ring-inner"><b>{completedTasks.length}/{total}</b><span>complete</span></div></div><div className="tv-stat-list"><div className="tv-stat-line"><i /><span>Completed</span><b>{completedToday}</b></div><div className="tv-stat-line"><i /><span>In progress</span><b>{inProgressToday}</b></div><div className="tv-stat-line"><i /><span>Overdue</span><b>{overdueCount}</b></div><div className="tv-stat-line"><i /><span>Total</span><b>{total}</b></div></div></div></section>
      </div>
    </div>}
  </div>
}
