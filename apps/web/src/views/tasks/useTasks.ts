import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ApiError, type ProjectResponse, type TaskOut } from '@aelys/shared'
import { Calendar, CalendarDays, CircleCheck, Inbox } from '../../icons'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import { dateKey, dayDiff, fmtDay, draftFromTask, parseQuickTokens, draftToInput, emptyDraft, fullTaskInput, groupTasksByDay, groupTasksInMatrix, isCompleted, isOverdue, taskMatchesQuery, type TaskDraft } from './taskModel'
import { useDurableDrafts } from '../../lib/durableDrafts'

type TaskView = 'inbox' | 'today' | 'upcoming' | 'completed' | 'matrix' | 'all'
type EditorState = { task: TaskOut; draft: TaskDraft; error: string; conflict: boolean; latest: TaskOut | null; fieldBase?: TaskOut }
export const VIEWS = [{ id: 'inbox', label: 'Inbox', Icon: Inbox }, { id: 'today', label: 'Today', Icon: Calendar }, { id: 'upcoming', label: 'Upcoming', Icon: CalendarDays }, { id: 'completed', label: 'Completed', Icon: CircleCheck }] as const
export const PRIORITIES = ['None', 'Low', 'Medium', 'High']
export const PRIORITY_COLORS = ['', '#2F6FE4', '#D97706', '#D93636']
// A date without a time is stored as 23:59, so that time is not shown.
function timeLabel(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (date.getHours() === 23 && date.getMinutes() === 59) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
const freshRead = { allowCacheFallback: false }
const isAuthError = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status)
function explainError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Version conflict: this task changed elsewhere. Compare the latest version before saving again. Your draft is unchanged.'
    if (isAuthError(error)) return 'Your session cannot save this task. Sign in again; keep this draft open.'
    if (error.status === 404) return 'This task or linked project is no longer available. Your draft is unchanged.'
    if (error.status === 422) return 'Check the task fields and selected project. The server could not accept these values.'
    return 'The server could not confirm this change. Your draft is unchanged. Try again after checking the connection.'
  }
  return 'The connection was interrupted. No save confirmation was received. Your draft is unchanged.'
}
function writableSource(apiStatus: ApiStatus, online: boolean, source: string) { return apiStatus === 'ready' && online && source === 'live' }

export function useTasks(apiStatus: ApiStatus) {
  const [tasks, setTasks] = useState<readonly TaskOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [projectsUnavailable, setProjectsUnavailable] = useState(false)
  const [source, setSource] = useState<'loading' | 'live' | 'cached' | 'error' | 'auth'>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [view, setView] = useState<TaskView>('today')
  const [matrixNow, setMatrixNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [highOnly, setHighOnly] = useState(false)
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const [newDraft, setNewDraft] = useState<TaskDraft>(emptyDraft)
  const [createError, setCreateError] = useState('')
  const [createUncertain, setCreateUncertain] = useState(false)
  const [checkedUncertain, setCheckedUncertain] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const editDrafts = useRef(new Map<string, EditorState>())
  const { drafts: durable, setDrafts: persistDrafts, ready: draftsReady, status: draftStatus } = useDurableDrafts<{ edits?: Record<string, EditorState>; quick?: TaskDraft }>('tasks')
  const restoredDrafts = useRef(false)
  useEffect(() => {
    if (!draftsReady) return
    if (!restoredDrafts.current) {
      restoredDrafts.current = true
      for (const [id, saved] of Object.entries(durable.edits ?? {})) if (!editDrafts.current.has(id)) editDrafts.current.set(id, saved)
      if (durable.quick) setNewDraft(current => current.title || current.description ? current : durable.quick!)
      return
    }
    const edits = Object.fromEntries(editDrafts.current)
    if (editor) {
      if (JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task))) edits[editor.task.id] = editor
      else delete edits[editor.task.id]
    }
    const next = { edits, quick: newDraft }
    if (JSON.stringify(next) !== JSON.stringify(durable)) persistDrafts(next)
  })
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const quickTitle = useRef<HTMLInputElement>(null)
  const quickError = useRef<HTMLParagraphElement>(null)
  const restoreNewFocus = useRef(false)
  const authRejected = useRef(false)
  const loadGeneration = useRef(0)
  const today = dateKey(new Date().toISOString())!
  const writeAllowed = writableSource(apiStatus, online, source)
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects])
  const projectName = (task: TaskOut) => task.project_id ? projectNames.get(task.project_id) ?? 'Unavailable project' : ''

  useEffect(() => {
    if (view !== 'matrix') return
    setMatrixNow(Date.now())
    const clock = window.setInterval(() => setMatrixNow(Date.now()), 60_000)
    return () => window.clearInterval(clock)
  }, [view])

  // Cached reads remain useful, but cannot prove a live source: explicitly bypass
  // fallback first. A 401/403 never falls back to private cached records.
  const load = useCallback(async (forceRefresh = true) => {
    const generation = ++loadGeneration.current
    setRefreshing(true)
    const client = getSharedApiClient()
    const rejectAccess = (error: unknown): never => {
      if (isAuthError(error)) { authRejected.current = true; setTasks([]); setProjects([]); setSource('auth'); setRefreshing(false) }
      throw error
    }
    const [taskResult, projectResult] = await Promise.allSettled([
      client.tasks(undefined, { ...freshRead, forceRefresh, onCached: value => {
        if (generation === loadGeneration.current && !authRejected.current) { setTasks(value as readonly TaskOut[]); setSource('cached') }
      } }).catch(rejectAccess),
      client.projects({ ...freshRead, forceRefresh, onCached: value => {
        if (generation === loadGeneration.current && !authRejected.current) setProjects(value as readonly ProjectResponse[])
      } }).catch(rejectAccess),
    ])
    let nextTasks: readonly TaskOut[] | undefined
    let nextSource: typeof source = 'live'
    if (taskResult.status === 'fulfilled') nextTasks = taskResult.value
    else {
      const error: unknown = taskResult.reason
      if (isAuthError(error)) nextSource = 'auth'
      else if (error instanceof ApiError && error.status < 500) nextSource = 'error'
      else {
        nextSource = 'cached'
        try { nextTasks = await client.tasks(undefined, { cacheOnly: true }) }
        catch (cachedError) { nextSource = isAuthError(cachedError) ? 'auth' : 'error' }
      }
    }
    let nextProjects: readonly ProjectResponse[] = []
    let unavailable = false
    if (projectResult.status === 'rejected' && isAuthError(projectResult.reason)) nextSource = 'auth'
    if (nextSource !== 'auth') {
      if (projectResult.status === 'fulfilled') nextProjects = projectResult.value
      else {
        unavailable = true
        try { nextProjects = await client.projects({ cacheOnly: true }) }
        catch (cachedError) { if (isAuthError(cachedError)) nextSource = 'auth' }
      }
    }
    if (nextSource === 'auth') { authRejected.current = true; setSource('auth'); setTasks([]); setProjects([]); setRefreshing(false); return false }
    if (generation !== loadGeneration.current) return false
    authRejected.current = false
    if (nextTasks) setTasks(nextTasks)
    setProjects(nextProjects)
    setProjectsUnavailable(unavailable)
    setSource(nextSource)
    setRefreshing(false)
    return nextSource === 'live'
  }, [])
  useEffect(() => { void load(false); return () => { loadGeneration.current++ } }, [load, apiStatus])
  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); if (navigator.onLine) void load() }
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [load])

  const openQuick = () => { if (!pendingRef.current) quickTitle.current?.focus() }
  useEffect(() => {
    if (!moreOpen) return
    const away = (event: MouseEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false) }
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setMoreOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [moreOpen])
  useEffect(() => { if (createError && !pending) quickError.current?.focus() }, [createError, pending])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.repeat || editor || document.querySelector('[role="dialog"]')) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return
      if (event.key.toLowerCase() === 'q') { event.preventDefault(); openQuick() }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  })
  useEffect(() => {
    const hasDraft = !!newDraft.title || !!newDraft.description || !!newDraft.dueDate || !!newDraft.projectId || !!editor && JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task)) || editDrafts.current.size > 0
    const beforeUnload = (event: BeforeUnloadEvent) => { if (hasDraft) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [newDraft, editor])

  useEffect(() => { if (!pending && restoreNewFocus.current) { restoreNewFocus.current = false; document.querySelector<HTMLElement>('.tasks-navigation [aria-selected="true"]')?.focus() } }, [pending])
  const upsert = (task: TaskOut) => { if (authRejected.current) return; loadGeneration.current++; setRefreshing(false); setTasks(items => items.some(item => item.id === task.id) ? items.map(item => item.id === task.id ? task : item) : [...items, task]) }
  const closeEditor = () => {
    if (pendingRef.current || !editor) return
    if (JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task)) || editor.error) editDrafts.current.set(editor.task.id, editor)
    else editDrafts.current.delete(editor.task.id)
    setEditor(null)
  }
  const openEditor = (task: TaskOut) => {
    if (pendingRef.current) return
    setMessage(''); setActionError(''); setConfirmDelete(false)
    setEditor(editDrafts.current.get(task.id) ?? { task, draft: draftFromTask(task), error: '', conflict: false, latest: null })
  }
  const [routeIntent, setRouteIntent] = useState<{ task: string | null; create: boolean } | null>(null)
  useEffect(() => {
    const readIntent = () => {
      if (window.location.pathname !== '/tasks') return
      const params = new URLSearchParams(window.location.search)
      const task = params.get('task')
      setRouteIntent(task ? { task, create: false } : params.get('create') === '1' ? { task: null, create: true } : null)
    }
    readIntent()
    window.addEventListener('popstate', readIntent)
    return () => window.removeEventListener('popstate', readIntent)
  }, [])
  useEffect(() => {
    if (!routeIntent || pending) return
    if (routeIntent.task && source === 'loading') return
    if (routeIntent.task && editor?.task.id === routeIntent.task) { setRouteIntent(null); return }
    if (routeIntent.task && !tasks.some(task => task.id === routeIntent.task)) {
      setActionError('This task could not be found in the loaded task list.')
      setRouteIntent(null)
      return
    }
    if (editor && (JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task)) || editor.error)) editDrafts.current.set(editor.task.id, editor)
    if (routeIntent.create) { setEditor(null); window.setTimeout(openQuick, 0) }
    else {
      const task = tasks.find(item => item.id === routeIntent.task)!
      setEditor(editDrafts.current.get(task.id) ?? { task, draft: draftFromTask(task), error: '', conflict: false, latest: null })
      setConfirmDelete(false); setActionError('')
    }
    setRouteIntent(null)
  }, [routeIntent, tasks, source, pending, editor])
  const beginWrite = () => { if (pendingRef.current || !writeAllowed) return false; pendingRef.current = true; setPending(true); setMessage(''); setActionError(''); return true }
  const endWrite = () => { pendingRef.current = false; setPending(false) }
  const tokenPatch = (parsed: ReturnType<typeof parseQuickTokens>, current: TaskDraft): Partial<TaskDraft> => ({ title: parsed.title, ...(parsed.dueDate || parsed.dueTime ? { dueDate: parsed.dueDate ?? (current.dueDate || today), dueTime: parsed.dueTime ?? (parsed.dueDate ? '' : current.dueTime) } : {}), ...(parsed.priority ? { priority: parsed.priority } : {}), ...(parsed.projectId ? { projectId: parsed.projectId } : {}) })
  const createTask = async (event: FormEvent) => {
    event.preventDefault()
    if (createUncertain) return
    let input
    const parsed = parseQuickTokens(newDraft.title, projects)
    const draft = { ...newDraft, ...tokenPatch(parsed, newDraft) }
    try { input = draftToInput(draft) } catch (error) { setCreateError((error as Error).message); quickTitle.current?.focus(); return }
    if (!beginWrite()) return
    setCreateError('')
    try {
      const saved = await getSharedApiClient().createTask(input, { queueOnOffline: false, idempotencyKey: crypto.randomUUID() })
      upsert(saved); setNewDraft(emptyDraft())
      setView(!saved.due_at ? 'inbox' : dateKey(saved.due_at)! <= today ? 'today' : 'upcoming'); setQuery(''); setProjectFilter('all'); setStatusFilter('all'); setHighOnly(false); setPriorityFilter('all'); setOverdueOnly(false)
      setMessage('Task created.'); restoreNewFocus.current = true
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.status >= 500
      setCreateUncertain(uncertain); setCheckedUncertain(false)
      setCreateError(explainError(error) + (uncertain ? ' Check the task list before another attempt; the task may have already been created.' : ''))
    } finally { endWrite() }
  }
  const saveEditor = async () => {
    if (!editor || editor.conflict) return
    let input
    try { input = draftToInput(editor.draft, editor.fieldBase ?? editor.task) }
    catch (error) { setEditor({ ...editor, error: (error as Error).message }); return }
    if (!beginWrite()) return
    try {
      const saved = await getSharedApiClient().updateTask(editor.task.id, { ...input, parent_task_id: editor.task.parent_task_id, rrule: editor.task.rrule, version: editor.task.version }, { queueOnOffline: false })
      upsert(saved); editDrafts.current.delete(saved.id); setEditor(null); setMessage('Changes saved.'); restoreNewFocus.current = true
    } catch (error) { setEditor({ ...editor, error: explainError(error), conflict: error instanceof ApiError && error.status === 409, latest: null }) }
    finally { endWrite() }
  }
  const deleteEditor = async () => {
    if (!editor || editor.conflict || !beginWrite()) return
    try {
      const latest = await getSharedApiClient().task(editor.task.id, freshRead)
      if (latest.version !== editor.task.version) {
        setEditor({ ...editor, conflict: true, latest, error: 'Version conflict: this task changed elsewhere. Compare the latest version before deleting.' })
        setConfirmDelete(false)
        return
      }
      await getSharedApiClient().deleteTask(editor.task.id, { version: editor.task.version }, { queueOnOffline: false })
      loadGeneration.current++; setRefreshing(false)
      setTasks(items => items.filter(item => item.id !== editor.task.id))
      editDrafts.current.delete(editor.task.id); setEditor(null); setConfirmDelete(false); setMessage('Task deleted.'); restoreNewFocus.current = true
    } catch (error) {
      setConfirmDelete(false)
      setEditor({ ...editor, error: explainError(error), conflict: error instanceof ApiError && error.status === 409, latest: null })
    } finally { endWrite() }
  }
  const toggle = async (task: TaskOut) => {
    if (!beginWrite()) return
    try {
      const saved = await getSharedApiClient().updateTask(task.id, { ...fullTaskInput(task), status: isCompleted(task) ? 'todo' : 'completed', version: task.version }, { queueOnOffline: false })
      upsert(saved); setMessage(isCompleted(saved) ? 'Task completed.' : 'Task reopened.')
    } catch (error) {
      setActionError(explainError(error))
      if (error instanceof ApiError && error.status === 409) setEditor({ ...(editDrafts.current.get(task.id) ?? { task, draft: draftFromTask(task) }), conflict: true, latest: null, error: explainError(error) })
    } finally { endWrite() }
  }
  const compareLatest = async () => {
    if (!editor || pendingRef.current) return
    pendingRef.current = true; setPending(true)
    try { const latest = await getSharedApiClient().task(editor.task.id); setEditor({ ...editor, latest }) }
    catch (error) { setEditor({ ...editor, error: explainError(error) }) }
    finally { endWrite() }
  }
  const clearFilters = () => { setQuery(''); setStatusFilter('all'); setProjectFilter('all'); setHighOnly(false); setPriorityFilter('all'); setOverdueOnly(false) }
  const inView = (task: TaskOut, target: TaskView) => target === 'all' ? true : target === 'completed' ? isCompleted(task) : !isCompleted(task) && (target === 'matrix' ? true : target === 'inbox' ? !task.due_at : target === 'today' ? !!task.due_at && dateKey(task.due_at)! <= today : !!task.due_at && dateKey(task.due_at)! > today)
  const viewTasks = tasks.filter(task => inView(task, view))
  const matching = viewTasks.filter(task => taskMatchesQuery(task, query, projectName(task)) && (projectFilter === 'all' || (projectFilter === 'none' ? !task.project_id : task.project_id === projectFilter)) && (statusFilter === 'all' || (statusFilter === 'completed' ? isCompleted(task) : !isCompleted(task))) && (priorityFilter === 'all' || task.priority === Number(priorityFilter)) && (!highOnly || task.priority >= 3) && (!overdueOnly || isOverdue(task)))
  const sortedTasks = [...matching].sort((a, b) => Number(isCompleted(a)) - Number(isCompleted(b)) || (a.due_at ?? '').localeCompare(b.due_at ?? '') || b.priority - a.priority || a.title.localeCompare(b.title))
  const groups = view === 'matrix' ? groupTasksInMatrix(sortedTasks, matrixNow) : view === 'today' ? [{ key: 'overdue', label: 'Overdue', tasks: sortedTasks.filter(task => dateKey(task.due_at)! < today) }, { key: today, label: 'Today', tasks: sortedTasks.filter(task => dateKey(task.due_at) === today) }].filter(group => group.tasks.length) : view === 'inbox' || view === 'completed' ? sortedTasks.length ? [{ key: view, label: view === 'inbox' ? 'Inbox' : 'Completed', tasks: sortedTasks }] : [] : groupTasksByDay(sortedTasks)
  const activeFilters = !!query || statusFilter !== 'all' || projectFilter !== 'all' || highOnly || priorityFilter !== 'all' || overdueOnly
  const filterCount = Number(priorityFilter !== 'all') + Number(projectFilter !== 'all') + Number(!!query)
  const groupTitle = (key: string) => key === 'overdue' ? 'Overdue' : key === 'inbox' ? 'Inbox' : key === 'completed' ? 'Completed' : key === today ? 'Today' : key ? fmtDay(key, today) : 'No date'
  const hiddenDrafts = editDrafts.current.size
  const offline = !online || apiStatus !== 'ready' || source === 'cached'
  const patchQuick = (patch: Partial<TaskDraft>) => setNewDraft(draft => ({ ...draft, ...patch }))
  const quickKeys = (event: ReactKeyboardEvent<HTMLFormElement>) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); quickTitle.current?.blur() } }

  const priorityOptions = [['all', 'Any priority'], ['3', 'High'], ['2', 'Medium'], ['1', 'Low'], ['0', 'No priority']] as const
  const projectIds = [...new Set([...projects.map(project => project.id), ...tasks.flatMap(task => task.project_id ? [task.project_id] : [])])]
  const newDateValue = !newDraft.dueDate ? 'none' : newDraft.dueDate === today ? 'today' : dayDiff(newDraft.dueDate, today) === 1 ? 'tomorrow' : newDraft.dueDate
  const pickNewDate = (value: string) => {
    const day = new Date(); day.setHours(12, 0, 0, 0)
    if (value === 'tomorrow') day.setDate(day.getDate() + 1)
    patchQuick(value === 'none' ? { dueDate: '', dueTime: '' } : { dueDate: value === 'today' || value === 'tomorrow' ? dateKey(day.toISOString())! : value, dueTime: '' })
  }
  const emptyTitle = activeFilters ? 'No tasks match your filters' : { inbox: 'Inbox is clear', today: 'Nothing left for today', upcoming: 'Nothing planned yet', completed: 'No completed tasks yet', matrix: 'No open tasks', all: 'No tasks yet' }[view]
  const groupSub = (key: string) => /^\d{4}-/.test(key) ? new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : key === 'inbox' ? 'Tasks without a date' : ''
  const whenFor = (task: TaskOut) => {
    const key = dateKey(task.due_at)
    if (!key) return ''
    return [view === 'today' && !isOverdue(task) && key === today ? '' : fmtDay(key, today), timeLabel(task.due_at)].filter(Boolean).join(' · ')
  }

  return { editor, message, actionError, source, tasks, load, refreshing, offline, projectsUnavailable, today, view, setView, inView, query, setQuery, moreRef, moreOpen, setMoreOpen, activeFilters, filterCount, priorityFilter, setPriorityFilter, priorityOptions, projectFilter, setProjectFilter, projectIds, projectNames, statusFilter, setStatusFilter, highOnly, setHighOnly, overdueOnly, setOverdueOnly, clearFilters, createTask, quickKeys, quickTitle, newDraft, pending, projects, patchQuick, tokenPatch, newDateValue, pickNewDate, writeAllowed, createUncertain, setCreateUncertain, createError, setCreateError, quickError, checkedUncertain, setCheckedUncertain, hiddenDrafts, editDrafts, setEditor, groups, groupTitle, groupSub, whenFor, openEditor, toggle, projectName, sortedTasks, emptyTitle, saveEditor, closeEditor, confirmDelete, setConfirmDelete, deleteEditor, draftStatus, compareLatest, upsert }
}
