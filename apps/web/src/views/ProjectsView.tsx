import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

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
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try {
      const client = getSharedApiClient()
      const [projectResult, taskResult] = await Promise.allSettled([client.projects(), client.tasks()])
      if (projectResult.status === 'rejected') throw projectResult.reason
      const tasks = taskResult.status === 'fulfilled' ? taskResult.value : []
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
    return needle ? projects.filter((project) => `${project.name} ${project.description}`.toLowerCase().includes(needle)) : projects
  }, [projects, query])

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
    <style>{`
      .projects-view { color:#1C1B22; padding-bottom:32px; }
      .projects-view * { box-sizing:border-box; }
      .pv-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; padding:26px 28px 22px; }
      .pv-eyebrow { margin:0 0 7px; color:#6A4CF2; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      .pv-hero h1 { margin:0; font:600 clamp(30px,4vw,40px)/1.1 Inter,-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif; letter-spacing:-.045em; }
      .pv-hero p { margin:8px 0 0; color:#625D69; font-size:14px; }
      .pv-toolbar { display:flex; align-items:center; gap:12px; padding:0 28px 18px; }
      .pv-search { min-width:220px; flex:1; height:42px; display:flex; align-items:center; gap:9px; padding:0 13px; border:1px solid #ECE7E3; border-radius:13px; color:#625D69; background:rgba(255,255,255,.88); }
      .pv-search input { min-width:0; flex:1; border:0; outline:0; color:#1C1B22; background:transparent; font-size:13px; }
      .pv-new { height:40px; display:flex; align-items:center; gap:8px; padding:0 16px; border:0; border-radius:12px; color:#fff; background:#6A4CF2; box-shadow:0 4px 12px rgba(106,76,242,.3); cursor:pointer; font-size:14px; font-weight:600; }
      .pv-form { display:grid; grid-template-columns:1fr 1fr auto auto; gap:8px; margin:0 28px 18px; padding:12px; border:1px solid #ECE7E3; border-radius:14px; background:rgba(255,255,255,.72); }
      .pv-form input { min-width:0; height:38px; padding:0 10px; border:1px solid #E7E2DE; border-radius:10px; outline:0; background:#fff; }
      .pv-form button { height:38px; padding:0 12px; border:0; border-radius:10px; cursor:pointer; }.pv-form button[type=submit] { color:#fff; background:#6A4CF2; }.pv-form button[type=button] { color:#625D69; background:#fff; }
      .pv-message { margin:0 28px 14px; color:#128A63; font-size:12px; }
      .pv-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; padding:0 28px; }
      .pv-card { min-width:0; min-height:218px; display:flex; flex-direction:column; padding:18px; border:1px solid rgba(255,255,255,.35); border-radius:20px; background:rgba(255,255,255,.88); box-shadow:0 8px 24px rgba(40,30,30,.07); backdrop-filter:blur(20px); }
      .pv-card-top { display:flex; align-items:center; gap:10px; }.pv-icon { width:40px; height:40px; display:grid; place-items:center; border-radius:12px; color:#5132D6; background:#EEEAFD; }.pv-card-top strong { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:16px; font-weight:600; }.pv-more { width:30px; height:30px; display:grid; place-items:center; border:0; border-radius:9px; color:#625D69; background:transparent; cursor:pointer; }
      .pv-card-description { min-height:42px; margin:16px 0 14px; color:#625D69; font-size:13px; line-height:19px; }.pv-status { display:inline-flex; width:max-content; padding:3px 8px; border-radius:10px; color:#128A63; background:#DCF5EC; font-size:11px; font-weight:600; }.pv-status--archived { color:#625D69; background:#F1EDEA; }
      .pv-progress-label { display:flex; justify-content:space-between; margin-top:auto; color:#625D69; font-size:12px; }.pv-progress { height:5px; margin-top:6px; overflow:hidden; border-radius:3px; background:#ECE7E3; }.pv-progress span { display:block; height:100%; border-radius:3px; background:#6A4CF2; }
      @media (max-width: 900px) { .pv-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      @media (max-width: 700px) { .pv-hero { align-items:flex-start; flex-direction:column; gap:14px; padding:24px 2px 18px; }.pv-toolbar { flex-wrap:wrap; padding-inline:2px; }.pv-search { width:100%; }.pv-new { margin-left:auto; }.pv-form { grid-template-columns:1fr; margin-inline:2px; }.pv-grid { grid-template-columns:1fr; padding-inline:2px; } }
    `}</style>
    <header className="pv-hero"><div><p className="pv-eyebrow">Workspace</p><h1>Projects</h1><p>Keep related work, notes and tasks in one context.</p></div><ApiStatusPill status={apiStatus} /></header>
    <div className="pv-toolbar"><label className="pv-search"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects…" aria-label="Search projects" /></label><button className="pv-new" type="button" onClick={() => setFormOpen((open) => !open)}><Icon name="plus" size={17} />New project</button></div>
    {formOpen && <form className="pv-form" onSubmit={createProject}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" aria-label="New project name" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Short description" aria-label="New project description" /><button type="submit">Save</button><button type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {message && <p className="pv-message" role="status">{message}</p>}
    {status !== 'ready' ? <div className="pv-empty"><EmptyProjects status={status} retry={() => void load()} /></div> : visible.length === 0 ? <div className="pv-empty"><StateCard status="empty" title={query ? 'No matching projects' : 'No projects yet'} description={query ? 'Try a different search term.' : 'Create your first project to connect tasks, notes and agent work.'} /></div> : <section className="pv-grid" aria-label="Projects">{visible.map((project) => { const ratio = project.taskCount === 0 ? 0 : Math.round((project.completedCount / project.taskCount) * 100); return <article className="pv-card" key={project.id}><div className="pv-card-top"><span className="pv-icon"><Icon name="folder" size={20} /></span><strong>{project.name}</strong><button className="pv-more" type="button" aria-label={`More actions for ${project.name}`}><Icon name="more-horizontal" size={17} /></button></div><p className="pv-card-description">{project.description || 'No description yet.'}</p><span className={`pv-status ${project.status === 'archived' ? 'pv-status--archived' : ''}`}>{project.status}</span><div className="pv-progress-label"><span>{project.completedCount} of {project.taskCount} tasks complete</span><b>{ratio}%</b></div><div className="pv-progress"><span style={{ width: `${ratio}%` }} /></div></article> })}</section>}
  </div>
}
