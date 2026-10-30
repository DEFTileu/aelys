import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './actual-projects-notes.css'

type ProjectCard = ProjectResponse & { taskCount: number; completedCount: number }

function makeOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isDone(task: TaskOut): boolean {
  return ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
}

function EmptyProjects({ status, retry }: { status: ApiStatus; retry: () => void }) {
  const copy = status === 'loading'
    ? ['Loading projects', 'Checking the connected project source.']
    : status === 'offline'
      ? ['Projects are offline', 'Reconnect to load the latest project data.']
      : ['Projects are unavailable', 'The project API did not respond. Check the connection and try again.']
  return <StateCard status={status} title={copy[0]} description={copy[1]} action={<button className="text-button" type="button" onClick={retry}><Icon name="refresh" size={14} />Try again</button>} />
}

export function ProjectsView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [projects, setProjects] = useState<readonly ProjectCard[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<readonly TaskOut[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('all')
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    setStatus(apiStatus === 'ready' ? 'loading' : apiStatus)
    try {
      const client = getSharedApiClient()
      const [projectResult, taskResult] = await Promise.allSettled([client.projects(), client.tasks()])
      if (projectResult.status === 'rejected') throw projectResult.reason
      const tasks = taskResult.status === 'fulfilled' ? taskResult.value : []
      setTasks(taskResult.status === 'fulfilled' ? tasks : null)
      const taskMap = new Map<string, { total: number; done: number }>()
      for (const task of tasks) {
        if (!task.project_id) continue
        const current = taskMap.get(task.project_id) ?? { total: 0, done: 0 }
        current.total += 1
        if (isDone(task)) current.done += 1
        taskMap.set(task.project_id, current)
      }
      setProjects(projectResult.value.map((project) => ({ ...project, taskCount: taskMap.get(project.id)?.total ?? 0, completedCount: taskMap.get(project.id)?.done ?? 0 })))
      setStatus('ready')
    } catch {
      setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
    }
  }

  useEffect(() => { void load() }, [apiStatus])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return projects.filter((project) => (filter === 'all' || (filter === 'archived' ? project.status === 'archived' : project.status !== 'archived')) && (!needle || `${project.name} ${project.description}`.toLowerCase().includes(needle)))
  }, [projects, query, filter])
  const selected = projects.find((project) => project.id === selectedId)
  const projectTasks = selected && tasks ? tasks.filter((task) => task.project_id === selected.id) : []

  const createProject = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    setMessage('')
    try {
      const operationId = makeOperationId()
      await getSharedApiClient().createProject({ name: trimmedName, description: description.trim() }, { idempotencyKey: operationId, offlineEntityKey: `pending:projects:${operationId}`, offlineEntityValue: { pending: true, name: trimmedName, description: description.trim() } })
      setName(''); setDescription(''); setFormOpen(false); await load()
    } catch (error) {
      if (error instanceof OfflineQueuedError) { setName(''); setDescription(''); setFormOpen(false); setMessage('Saved on this device and queued for sync.') }
      else if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`)
      else setMessage('Could not create this project.')
    }
  }

  return <div className="page projects-view">
    <div className="pv-toolbar">
      <div className="pv-filters" role="group" aria-label="Filter projects">{(['all', 'active', 'archived'] as const).map((item) => <button key={item} type="button" aria-pressed={filter === item} onClick={() => { setFilter(item); setSelectedId(null) }}>{item[0].toUpperCase() + item.slice(1)} <span>{item === 'all' ? projects.length : projects.filter((project) => item === 'archived' ? project.status === 'archived' : project.status !== 'archived').length}</span></button>)}</div>
      <ApiStatusPill status={apiStatus} />
      <label className="pv-search"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects…" aria-label="Search projects" /></label>
      <button className="pv-new" type="button" onClick={() => { setSelectedId(null); setFormOpen((open) => !open) }}><Icon name="plus" size={17} />New project</button>
    </div>
    {formOpen && <form className="pv-form" onSubmit={createProject}><label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" aria-label="New project name" /></label><label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this project about?" aria-label="New project description" /></label><button className="pv-new" type="submit">Save</button><button className="pn-button" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {message && <p className="pn-message" role="status">{message}</p>}
    {status !== 'ready' ? <EmptyProjects status={status} retry={() => void load()} /> : selected ? <div className="pv-detail">
      <button className="pn-button pv-back" type="button" onClick={() => setSelectedId(null)}>← All projects</button>
      <section className="pn-card pv-detail-head"><span className="pv-icon"><Icon name="folder" size={24} /></span><div><h2>{selected.name}</h2><span className="pv-status">{selected.status}</span><p>{selected.description || 'No description yet.'}</p></div></section>
      <div className="pv-detail-grid"><section className="pn-card pv-task-list"><h3>Tasks <small>{tasks ? projectTasks.length : ''}</small></h3>{tasks === null ? <p>Tasks are unavailable. Try again to load project progress.</p> : projectTasks.length ? projectTasks.map((task) => <div className="pv-task" key={task.id}><span className={isDone(task) ? 'pv-task-dot pv-task-dot--done' : 'pv-task-dot'} aria-hidden="true">{isDone(task) ? '✓' : ''}</span><span>{task.title}</span><small>{task.status}</small></div>) : <p>No tasks linked to this project yet.</p>}</section>
      <section className="pn-card pv-overview"><h3>Overview</h3>{tasks === null ? <p>Progress unavailable</p> : <><strong>{selected.taskCount ? Math.round(selected.completedCount / selected.taskCount * 100) + '%' : '—'}</strong><p>{selected.taskCount - selected.completedCount} open · {selected.completedCount} done</p></>}</section></div>
    </div> : visible.length === 0 ? <StateCard status="empty" title={query ? 'No matching projects' : 'No projects here'} description={query ? 'Try a different search term.' : 'Create a project or choose another filter.'} /> : <section className="pv-grid" aria-label="Projects">{visible.map((project) => { const ratio = project.taskCount === 0 ? 0 : Math.round((project.completedCount / project.taskCount) * 100); const next = tasks?.find((task) => task.project_id === project.id && !isDone(task)); return <button type="button" className="pn-card pv-card" key={project.id} onClick={() => setSelectedId(project.id)}><span className="pv-card-top"><span className="pv-icon"><Icon name="folder" size={20} /></span><span className="pv-card-name"><strong>{project.name}</strong><span className="pv-status">{project.status}</span></span></span><span className="pv-card-description">{project.description || 'No description yet.'}</span><span className="pv-progress-label"><span>Progress</span><b>{tasks === null || !project.taskCount ? '—' : `${ratio}%`}</b></span><span className="pv-progress"><span style={{ width: `${ratio}%` }} /></span><span className="pv-next"><small>Next up</small><strong>{tasks === null ? 'Tasks unavailable' : next?.title ?? 'Nothing planned'}</strong></span><span className="pv-meta">{tasks === null ? 'Task counts unavailable' : `${project.taskCount - project.completedCount} open · ${project.completedCount} done`}</span></button> })}</section>}
  </div>
}
