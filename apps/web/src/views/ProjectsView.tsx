import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import { fullTaskInput, isOverdue } from './tasks/taskModel'
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
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [notes, setNotes] = useState<readonly NoteOut[] | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskUncertain, setTaskUncertain] = useState(false)

  const load = async () => {
    setStatus(apiStatus === 'ready' ? 'loading' : apiStatus)
    try {
      const client = getSharedApiClient()
      const [projectResult, taskResult, noteResult] = await Promise.allSettled([client.projects(), client.tasks(), Promise.resolve().then(() => client.notes())])
      setNotes(noteResult.status === 'fulfilled' ? noteResult.value : null)
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
      setStatus('ready'); if (taskResult.status === 'fulfilled') setTaskUncertain(false)
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

  const updateProject = async (changes: { name?: string; description?: string; status?: string }, target = selected) => {
    if (!target || busy) return
    setBusy(true); setMessage('')
    try {
      const saved = await getSharedApiClient().updateProject(target.id, { ...changes, version: target.version }, { queueOnOffline: false })
      setProjects((current) => current.map((project) => project.id === saved.id ? { ...project, ...saved } : project))
      setEditing(false)
    } catch (error) { setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not update this project. Your changes are preserved.') }
    finally { setBusy(false) }
  }
  const deleteProject = async (target = selected) => {
    if (!target || busy || !window.confirm(`Delete ${target.name}?`)) return
    setBusy(true); setMessage('')
    try {
      await getSharedApiClient().deleteProject(target.id, undefined, { queueOnOffline: false })
      setProjects((current) => current.filter((project) => project.id !== target.id)); setSelectedId(null)
    } catch (error) { setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not delete this project.') }
    finally { setBusy(false) }
  }

  const upsertTask = (saved: TaskOut) => {
    setTasks((current) => {
      const updated = [...(current ?? []).filter((task) => task.id !== saved.id), saved]
      setProjects((projects) => projects.map((project) => {
        const linked = updated.filter((task) => task.project_id === project.id)
        return { ...project, taskCount: linked.length, completedCount: linked.filter(isDone).length }
      }))
      return updated
    })
  }
  const createTask = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected || !taskTitle.trim() || busy || taskUncertain || apiStatus !== 'ready') return
    setBusy(true); setMessage('')
    try {
      const saved = await getSharedApiClient().createTask({ title: taskTitle.trim(), project_id: selected.id }, { idempotencyKey: makeOperationId(), queueOnOffline: false })
      upsertTask(saved); setTaskTitle('')
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.status >= 500 || error.status === 408
      setTaskUncertain(uncertain)
      setMessage(uncertain ? 'Task creation may have succeeded. Reload and check the task list before trying again.' : `${error.code}: ${error.message}`)
    } finally { setBusy(false) }
  }
  const toggleTask = async (task: TaskOut) => {
    if (busy || apiStatus !== 'ready') return
    setBusy(true); setMessage('')
    try { upsertTask(await getSharedApiClient().updateTask(task.id, { ...fullTaskInput(task), status: isDone(task) ? 'todo' : 'completed', version: task.version }, { queueOnOffline: false })) }
    catch (error) { setMessage(error instanceof ApiError && error.status === 409 ? 'This task changed elsewhere. Reload to see the latest version.' : 'Could not confirm the task update. Reload before trying again.') }
    finally { setBusy(false) }
  }
  const openNote = (id: string) => { window.history.pushState({}, '', `/notes?note=${encodeURIComponent(id)}`); window.dispatchEvent(new PopStateEvent('popstate')) }

  return <div className="page projects-view">
    {!selected && <div className="pv-toolbar">
      <div className="pv-filters" role="group" aria-label="Filter projects">{(['all', 'active', 'archived'] as const).map((item) => <button key={item} type="button" aria-pressed={filter === item} onClick={() => { setFilter(item); setSelectedId(null) }}>{item[0].toUpperCase() + item.slice(1)} <span>{item === 'all' ? projects.length : projects.filter((project) => item === 'archived' ? project.status === 'archived' : project.status !== 'archived').length}</span></button>)}</div>
      <ApiStatusPill status={apiStatus} />
      <label className="pv-search"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects…" aria-label="Search projects" /></label>
      <button className="pv-new" type="button" onClick={() => { setSelectedId(null); setFormOpen((open) => !open) }}><Icon name="plus" size={17} />New project</button>
    </div>}
    {formOpen && !selected && <form className="pv-form" onSubmit={createProject}><label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" aria-label="New project name" /></label><label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this project about?" aria-label="New project description" /></label><button className="pv-new" type="submit">Save</button><button className="pn-button" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {message && <p className="pn-message" role="status">{message} {taskUncertain && <button className="pn-button" type="button" onClick={() => void load()}>Reload tasks</button>}</p>}
    {status !== 'ready' ? <EmptyProjects status={status} retry={() => void load()} /> : selected ? <div className="pv-detail">
      <button className="pn-button pv-back" type="button" onClick={() => setSelectedId(null)}>← All projects</button>
      <section className="pn-card pv-detail-head"><span className="pv-icon"><Icon name="folder" size={24} /></span>{editing ? <form className="pv-edit" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void updateProject({ name: name.trim(), description: description.trim() }) }}><div><input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} /><textarea aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} /></div><button className="pn-button" type="button" onClick={() => setEditing(false)}>Cancel</button><button className="pv-new" disabled={busy || !name.trim()} type="submit">Save</button></form> : <><div className="pv-detail-title"><h2>{selected.name}</h2><span className="pv-status">{selected.status}</span><p>{selected.description || 'No description yet.'}</p><div className="pv-mobile-detail-progress"><span>{tasks === null ? 'Task counts unavailable' : `${selected.taskCount - selected.completedCount} open · ${selected.completedCount} done`}</span><b>{tasks === null || !selected.taskCount ? '—' : `${Math.round(selected.completedCount / selected.taskCount * 100)}%`}</b><span className="pv-progress"><span style={{ width: `${selected.taskCount ? selected.completedCount / selected.taskCount * 100 : 0}%` }} /></span></div></div><div className="pv-detail-actions"><button className="pn-button" type="button" onClick={() => { setName(selected.name); setDescription(selected.description); setEditing(true) }}>Edit</button><button className="pn-button" type="button" disabled={busy} onClick={() => void updateProject({ status: selected.status === 'archived' ? 'active' : 'archived' })}>{selected.status === 'archived' ? 'Unarchive' : 'Archive'}</button><button className="pn-button" type="button" disabled={busy} onClick={() => void deleteProject()}>Delete</button></div></>}</section>
      <div className="pv-detail-grid"><section className="pn-card pv-task-list"><h3>Tasks <small>{tasks ? projectTasks.length : ''}</small></h3><form className="pv-add-task" onSubmit={createTask}><Icon name="plus" size={16} /><input aria-label="Add a task to this project" placeholder="Add a task to this project" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} disabled={busy || taskUncertain || apiStatus !== 'ready'} /><button type="submit" disabled={busy || taskUncertain || !taskTitle.trim() || apiStatus !== 'ready'}>Add</button></form>{tasks === null ? <p>Tasks are unavailable. Try again to load project progress.</p> : projectTasks.length ? projectTasks.map((task) => <div className="pv-task" key={task.id}><button type="button" role="checkbox" aria-checked={isDone(task)} aria-label={`Toggle ${task.title}`} disabled={busy || apiStatus !== 'ready'} onClick={() => void toggleTask(task)} className={isDone(task) ? 'pv-task-dot pv-task-dot--done' : 'pv-task-dot'}>{isDone(task) ? '✓' : ''}</button><span>{task.title}</span>{task.due_at && <small>{new Date(task.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>}</div>) : <p>No tasks yet — progress appears once you add some.</p>}</section>
      <div className="pv-detail-side"><section className="pn-card pv-overview"><h3>Overview</h3>{tasks === null ? <p>Progress unavailable</p> : <div className="pv-overview-content"><div className="pv-ring" style={{ background: `conic-gradient(var(--accent, var(--purple)) 0 ${selected.taskCount ? selected.completedCount / selected.taskCount * 100 : 0}%, var(--surface-soft) 0)` }}><strong>{selected.taskCount ? Math.round(selected.completedCount / selected.taskCount * 100) + '%' : '—'}</strong></div><div className="pv-counts"><span><b>{selected.taskCount - selected.completedCount}</b>Open</span><span><b>{selected.completedCount}</b>Done</span><span><b>{projectTasks.filter((task) => isOverdue(task)).length}</b>Overdue</span><span><b>{selected.taskCount}</b>Total</span></div></div>}</section><section className="pn-card pv-linked"><h3>Linked notes</h3>{notes === null ? <p>Notes unavailable.</p> : notes.filter((note) => note.project_id === selected.id).length ? notes.filter((note) => note.project_id === selected.id).map((note) => <button key={note.id} type="button" onClick={() => openNote(note.id)}><span>▤</span><span><strong>{note.title}</strong><small>{note.markdown_body || 'Empty note'}</small></span></button>) : <p>No notes linked to this project.</p>}</section></div></div>
    </div> : visible.length === 0 ? <StateCard status="empty" title={query ? 'No matching projects' : 'No projects here'} description={query ? 'Try a different search term.' : 'Create a project or choose another filter.'} /> : <section className="pv-grid" aria-label="Projects">{visible.map((project) => { const ratio = project.taskCount === 0 ? 0 : Math.round((project.completedCount / project.taskCount) * 100); const next = tasks?.find((task) => task.project_id === project.id && !isDone(task)); return <div className="pn-card pv-card" key={project.id} onClick={(event) => { if (!(event.target as HTMLElement).closest('button, [role="menu"]')) { setSelectedId(project.id); setMenuId(null) } }}><div className="pv-card-top"><span className="pv-icon"><Icon name="folder" size={20} /></span><button className="pv-card-open" type="button" onClick={() => { setSelectedId(project.id); setMenuId(null) }}><span className="pv-card-name"><strong>{project.name}</strong><span className="pv-status">{project.status}</span><span className="pv-mobile-meta">{tasks === null ? 'Task counts unavailable' : `${project.taskCount - project.completedCount} open · ${project.completedCount} done`}</span></span></button><b className="pv-mobile-percent">{tasks === null || !project.taskCount ? '—' : `${ratio}%`}</b><button type="button" className="pv-menu-trigger" aria-label={`Project actions: ${project.name}`} aria-haspopup="menu" aria-expanded={menuId === project.id} onClick={() => setMenuId(menuId === project.id ? null : project.id)}>•••</button>{menuId === project.id && <div className="pv-menu" role="menu"><button role="menuitem" type="button" onClick={() => { setSelectedId(project.id); setMenuId(null) }}>Open</button><button role="menuitem" type="button" onClick={() => { setSelectedId(project.id); setName(project.name); setDescription(project.description); setEditing(true); setMenuId(null) }}>Edit details</button><button role="menuitem" type="button" onClick={() => { setMenuId(null); void updateProject({ status: project.status === 'archived' ? 'active' : 'archived' }, project) }}>{project.status === 'archived' ? 'Unarchive' : 'Archive'}</button><button role="menuitem" type="button" onClick={() => { setMenuId(null); void deleteProject(project) }}>Delete</button></div>}</div><span className="pv-card-description">{project.description || 'No description yet.'}</span><span className="pv-progress-label"><span>Progress</span><b>{tasks === null || !project.taskCount ? '—' : `${ratio}%`}</b></span><span className="pv-progress"><span style={{ width: `${ratio}%` }} /></span><span className="pv-next"><small>Next up</small><strong>{tasks === null ? 'Tasks unavailable' : next?.title ?? 'Nothing planned'}</strong></span><span className="pv-meta">{tasks === null ? 'Task counts unavailable' : `${project.taskCount - project.completedCount} open · ${project.completedCount} done`}</span></div> })}</section>}
  </div>
}
