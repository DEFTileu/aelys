import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { NoteOut, ProjectResponse, TaskOut } from '@aelys/shared'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import { fullTaskInput } from '../tasks/taskModel'

export type ProjectCard = ProjectResponse & { taskCount: number; completedCount: number }

function makeOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function isDone(task: TaskOut): boolean {
  return ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
}

// All Projects state and handlers; the desktop and mobile screens render from this.
export function useProjects(apiStatus: ApiStatus) {
  const [projects, setProjects] = useState<readonly ProjectCard[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<readonly TaskOut[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('active')
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
  return { apiStatus, projects, query, setQuery, selectedId, setSelectedId, tasks, filter, setFilter, status, formOpen, setFormOpen, name, setName, description, setDescription, message, editing, setEditing, busy, menuId, setMenuId, notes, taskTitle, setTaskTitle, taskUncertain, load, visible, selected, projectTasks, createProject, updateProject, deleteProject, createTask, toggleTask, openNote }
}
