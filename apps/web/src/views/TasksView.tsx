import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ApiError, type ProjectResponse, type TaskOut } from '@aelys/shared'
import { Calendar, CalendarDays, Check, CircleCheck, CircleCheckBig, CirclePlus, Clock, Flag, Inbox, ListFilter, Search } from '../icons'
import { getSharedApiClient } from '../lib/api'
import { useIsMobile } from '../lib/useIsMobile'
import { MobileHeader } from '../components/MobileHeader'
import type { ApiStatus } from '../types'
import { TaskEditor } from './tasks/TaskEditor'
import { dateKey, dayDiff, fmtDay, projectColor, draftFromTask, parseQuickTokens, draftToInput, emptyDraft, fullTaskInput, groupTasksByDay, groupTasksInMatrix, isCompleted, isOverdue, taskMatchesQuery, type TaskDraft } from './tasks/taskModel'
import { PageSkeleton } from '../components/PageSkeleton'
import './desktop/page-tokens.css'
import './desktop/tasks.css'
import { useDurableDrafts } from '../lib/durableDrafts'

type TaskView = 'inbox' | 'today' | 'upcoming' | 'completed' | 'matrix' | 'all'
type EditorState = { task: TaskOut; draft: TaskDraft; error: string; conflict: boolean; latest: TaskOut | null; fieldBase?: TaskOut }
const VIEWS = [{ id: 'inbox', label: 'Inbox', Icon: Inbox }, { id: 'today', label: 'Today', Icon: Calendar }, { id: 'upcoming', label: 'Upcoming', Icon: CalendarDays }, { id: 'completed', label: 'Completed', Icon: CircleCheck }] as const
const PRIORITIES = ['None', 'Low', 'Medium', 'High']
const PRIORITY_COLORS = ['', '#2F6FE4', '#D97706', '#D93636']
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

export function TasksView({ apiStatus }: { apiStatus: ApiStatus }) {
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
  const mobile = useIsMobile()
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

  return <div className={`tasks-screen${editor ? ' tasks-screen--editing' : ''}`}>
    <div className="tasks-main">
      {message && <p className="tasks-feedback" role="status">{message}</p>}
      {actionError && <p className="tasks-error" role="alert">{actionError}</p>}
      {source === 'loading' && <PageSkeleton kind="list" label="tasks" />}
      {source === 'auth' && <p className="tasks-error" role="alert">Your session ended. Sign in again to load your private tasks.</p>}
      {source === 'error' && !tasks.length && <PageSkeleton kind="list" label="tasks" phase="error" onRetry={() => void load()} />}
      {source === 'error' && !!tasks.length && <div className="tasks-error" role="alert">Tasks could not be loaded. Previously loaded records may be out of date. <button type="button" disabled={refreshing} onClick={() => void load()}>Try again</button></div>}
      {offline && source !== 'loading' && source !== 'auth' && <p className="tasks-source" role="status">Offline or connection unavailable. Showing cached or previously loaded tasks. Saving requires a connection; drafts stay open while you work here.</p>}
      {projectsUnavailable && <p className="tasks-source" role="status">Projects could not be refreshed. Existing links are preserved; reconnect to choose a project.</p>}
      <MobileHeader sub={`${tasks.filter(task => !isCompleted(task) && task.due_at && dateKey(task.due_at)! <= today).length} left for today`} />
      <div className="tasks-top-row">
        <div className="tasks-navigation" role="tablist" aria-label="Task views" onKeyDown={event => {
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = Math.max(0, VIEWS.findIndex(item => item.id === view))
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length
          setView(VIEWS[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>
          {VIEWS.map(({ id, label: fullLabel, Icon }) => { const label = mobile && id === 'completed' ? 'Done' : fullLabel; return <button key={id} type="button" role="tab" aria-label={label} id={`tasks-tab-${id}`} aria-controls="tasks-panel" aria-selected={view === id} tabIndex={view === id || ((view === 'all' || view === 'matrix') && id === 'today') ? 0 : -1} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span><b aria-hidden="true">{tasks.filter(task => inView(task, id)).length}</b></button> })}
        </div>
        <span className="tasks-spacer" />
        {!mobile && <label className="tasks-search"><Search size={16} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>}
        <div className="tasks-more" ref={moreRef}>
          <button type="button" className="tasks-filter-button" aria-label="Filters and views" aria-haspopup="true" aria-expanded={moreOpen} data-active={activeFilters ? 'true' : undefined} onClick={() => setMoreOpen(value => !value)}><ListFilter size={16} />{!mobile && 'Filter'}{filterCount > 0 && <b>{filterCount}</b>}</button>
          {moreOpen && <div className="tasks-more-panel">
            {mobile && <label className="tasks-more-search"><Search size={16} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>}
            <div className="tasks-more-status">Priority<select aria-label="Filter by priority" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}>{priorityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="tasks-more-status">Project<select aria-label="Filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option><option value="none">No project</option>{projectIds.map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</select></div>
            <div className="tasks-more-status">Status<select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option></select></div>
            <button type="button" aria-pressed={highOnly} onClick={() => setHighOnly(value => !value)}><Flag size={15} />High priority</button>
            <button type="button" aria-pressed={overdueOnly} onClick={() => { setOverdueOnly(value => !value); if (!overdueOnly) setView('all') }}>Overdue</button>
            <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>All tasks</button>
            <button type="button" aria-pressed={view === 'matrix'} onClick={() => setView('matrix')}>Matrix</button>
            {activeFilters && <button type="button" onClick={clearFilters}>Clear filters</button>}
          </div>}
        </div>
        {filterCount > 0 && <button type="button" className="tasks-reset" onClick={() => { setPriorityFilter('all'); setProjectFilter('all'); setQuery('') }}>Reset</button>}
      </div>
      <form className="tasks-quick" aria-label="Quick add task" onSubmit={createTask} onKeyDown={quickKeys}>
        <CirclePlus size={20} className="tasks-quick-icon" />
        <input ref={quickTitle} aria-label="Add a task" aria-describedby="tasks-quick-hint" placeholder={mobile ? 'Add a task' : 'Add a task — Enter to save, Q to focus'} value={newDraft.title} disabled={pending} onChange={event => { const parsed = parseQuickTokens(event.target.value, projects, new Date(), false); patchQuick(tokenPatch(parsed, newDraft)) }} />
        <span id="tasks-quick-hint" className="tasks-sr">Try @tomorrow, @14:30, !p1 or #project</span>
        {newDraft.title.trim() && <>
        <select className="tasks-quick-select" aria-label="Date" value={newDateValue} disabled={pending} onChange={event => pickNewDate(event.target.value)}><option value="none">No date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option>{!['none', 'today', 'tomorrow'].includes(newDateValue) && <option value={newDateValue}>{fmtDay(newDateValue, today)}</option>}</select>
        <select className="tasks-quick-select" aria-label="Priority" value={newDraft.priority} disabled={pending} onChange={event => patchQuick({ priority: event.target.value })}><option value="0">No priority</option><option value="3">High</option><option value="2">Medium</option><option value="1">Low</option></select>
        <select className="tasks-quick-select tasks-quick-project" aria-label="Project" value={newDraft.projectId} disabled={pending} onChange={event => patchQuick({ projectId: event.target.value })}><option value="">No project</option>{projectIds.map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</select>
        </>}
        <button className="tasks-add" aria-label="Add task" type="submit" data-ready={newDraft.title.trim() ? 'true' : 'false'} disabled={!writeAllowed || pending || createUncertain || !newDraft.title.trim()}>{pending ? 'Saving…' : 'Add'}</button>
        {createError && <p ref={quickError} tabIndex={-1} className="tasks-error tasks-quick-error" role="alert">{createError}</p>}
        {createUncertain && <div className="tasks-recovery"><button type="button" disabled={pending || refreshing} onClick={async () => { if (await load()) { setCheckedUncertain(true); setView('all'); clearFilters() } }}>Check task list</button>{checkedUncertain && <><span>If it is already in the list, close this draft. Otherwise:</span><button type="button" onClick={() => { setCreateUncertain(false); setCreateError(''); setCheckedUncertain(false) }}>Allow another attempt</button></>}</div>}
      </form>
      <section role="tabpanel" id="tasks-panel" aria-labelledby={view === 'all' || view === 'matrix' ? undefined : `tasks-tab-${view}`} aria-label={view === 'all' ? 'All tasks' : view === 'matrix' ? 'Matrix' : undefined} tabIndex={0} className="tasks-panel">
        {hiddenDrafts > 0 && <div className="tasks-draft-shelf"><span>Unsent edits</span>{[...editDrafts.current.values()].map(saved => <button type="button" key={saved.task.id} onClick={() => setEditor(saved)}>{saved.draft.title || saved.task.title}</button>)}</div>}
        <div className={view === 'matrix' ? 'tasks-matrix' : 'tasks-groups'}>
          {groups.map(group => <section className="tasks-date-group" key={group.key} aria-label={view === 'matrix' ? group.label : groupTitle(group.key)}>
            <h4 data-overdue={group.key === 'overdue' ? 'true' : undefined}><span className="tasks-group-title">{view === 'matrix' ? group.label : groupTitle(group.key)}</span> <span className="tasks-group-count">{group.tasks.length}</span><span className="tasks-spacer" />{(view === 'matrix' ? '' : groupSub(group.key)) && <time className="tasks-group-date" dateTime={group.key === today ? today : undefined}>{groupSub(group.key)}</time>}</h4>
            {view === 'matrix' && !group.tasks.length && <p className="tasks-help">No tasks</p>}
            <ul>{group.tasks.map(task => {
              const overdue = isOverdue(task) && dateKey(task.due_at)! < today
              const when = whenFor(task)
              const color = task.project_id ? projectColor(task.project_id) : ''
              return <li data-task-row={task.id} className={`tasks-item${isCompleted(task) ? ' tasks-item--done' : ''}${editor?.task.id === task.id ? ' tasks-item--open' : ''}`} key={task.id} role="button" tabIndex={-1} aria-hidden={undefined} onClick={() => openEditor(task)}>
                <button type="button" role="checkbox" aria-checked={isCompleted(task)} aria-label={`${isCompleted(task) ? 'Reopen' : 'Complete'} ${task.title}`} className="tasks-check" disabled={pending || !writeAllowed} onClick={event => { event.stopPropagation(); void toggle(task) }}>{isCompleted(task) && <Check size={13} />}</button>
                <div className="tasks-body">
                <button type="button" className="tasks-open" aria-label={`Open task: ${task.title}`} data-task-editor-trigger onClick={event => { event.stopPropagation(); openEditor(task) }} disabled={pending}><span className="tasks-label"><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}</span></button>
                {task.project_id && <span className="tasks-project" style={{ color, background: `${color}1A` }}>{projectName(task)}</span>}
                {task.status === 'in_progress' && <span className="tasks-project tasks-status">In progress</span>}
                {when && <time className={`tasks-due${overdue ? ' tasks-due--overdue' : ''}`} dateTime={task.due_at ?? undefined}><Clock size={12} aria-hidden="true" />{when}</time>}
                </div>
                <span className="tasks-priority" title={task.priority > 0 ? `${PRIORITIES[task.priority] ?? task.priority} priority` : undefined}>{task.priority > 0 && <Flag size={15} style={{ color: PRIORITY_COLORS[task.priority] || PRIORITY_COLORS[3] }} />}</span>
              </li>
            })}</ul>
          </section>)}
        </div>
        {!sortedTasks.length && source !== 'loading' && source !== 'auth' && source !== 'error' && <div className="tasks-empty"><span className="tasks-empty-icon"><CircleCheckBig size={24} /></span><p>{emptyTitle}</p><small>{activeFilters ? 'Try a different search or reset filters.' : 'Add a task above — press Q to jump to the field.'}</small>{activeFilters && <button type="button" onClick={() => { clearFilters(); setView('all') }}>Show all tasks</button>}</div>}
      </section>
    </div>
    {editor && <TaskEditor value={editor.draft} onChange={draft => setEditor({ ...editor, draft })} task={editor.task} projects={projects} projectsUnavailable={projectsUnavailable} pending={pending} saveDisabled={!writeAllowed || editor.conflict} error={editor.error} onSave={() => void saveEditor()} onClose={closeEditor} dirty={JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task))} onRevert={() => { editDrafts.current.delete(editor.task.id); setEditor({ ...editor, draft: draftFromTask(editor.task), error: editor.conflict ? editor.error : '' }); setConfirmDelete(false) }} confirmDelete={confirmDelete} onDelete={() => { if (confirmDelete) void deleteEditor(); else setConfirmDelete(true) }} onCancelDelete={() => setConfirmDelete(false)} deleteDisabled={!writeAllowed || editor.conflict} notice={<>
      {!writeAllowed && <p className="tasks-source">Saving requires a connection. You can keep editing this draft.</p>}
      <p className="task-editor__help">{draftStatus}. Closing keeps your draft available here. {editor.task.rrule ? 'Existing recurrence is preserved.' : ''}</p>
      {editor.conflict && <div className="tasks-conflict"><p>This task changed elsewhere. Compare before replacing its fields.</p><button type="button" disabled={pending || !writeAllowed} onClick={() => void compareLatest()}>Compare latest</button>{editor.latest && <><h3>Latest saved version</h3><dl><dt>Title</dt><dd>{editor.latest.title}</dd><dt>Description</dt><dd>{editor.latest.description || 'None'}</dd><dt>Date</dt><dd>{editor.latest.due_at ? new Date(editor.latest.due_at).toLocaleString() : 'No date'}</dd><dt>Priority</dt><dd>{PRIORITIES[editor.latest.priority] ?? editor.latest.priority}</dd><dt>Project</dt><dd>{projectName(editor.latest) || 'None'}</dd><dt>Status</dt><dd>{editor.latest.status}</dd></dl><p>Keep my draft replaces these fields when you save. Parent and recurrence keep the latest saved values.</p><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ ...editor, fieldBase: editor.fieldBase ?? editor.task, task: latest, conflict: false, latest: null, error: '' }) }}>Keep my draft</button><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ task: latest, draft: draftFromTask(latest), conflict: false, latest: null, error: '' }) }}>Use latest version</button></>}</div>}
    </>} />}
  </div>
}
