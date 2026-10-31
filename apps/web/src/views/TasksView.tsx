import { StyledSelect } from '../components/controls/StyledSelect'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ApiError, type ProjectResponse, type TaskOut } from '@aelys/shared'
import { Calendar, CalendarDays, Check, Clock, Ellipsis, Flag, Folder, Inbox, SquareCheck, Plus, RefreshCw, Search, X } from '../icons'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import { TaskEditor } from './tasks/TaskEditor'
import { dateKey, draftFromTask, draftToInput, emptyDraft, fullTaskInput, groupTasksByDay, isCompleted, isOverdue, taskMatchesQuery, type TaskDraft } from './tasks/taskModel'
import './desktop/tasks.css'

type TaskView = 'inbox' | 'today' | 'upcoming' | 'completed' | 'all'
type EditorState = { task: TaskOut; draft: TaskDraft; error: string; conflict: boolean; latest: TaskOut | null; fieldBase?: TaskOut }
const VIEWS = [{ id: 'inbox', label: 'Inbox', Icon: Inbox }, { id: 'today', label: 'Today', Icon: Calendar }, { id: 'upcoming', label: 'Upcoming', Icon: CalendarDays }, { id: 'completed', label: 'Completed', Icon: SquareCheck }] as const
const PRIORITIES = ['None', 'Low', 'Medium', 'High']
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
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [highOnly, setHighOnly] = useState(false)
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [newDraft, setNewDraft] = useState<TaskDraft>(emptyDraft)
  const [createError, setCreateError] = useState('')
  const [createUncertain, setCreateUncertain] = useState(false)
  const [checkedUncertain, setCheckedUncertain] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const editDrafts = useRef(new Map<string, EditorState>())
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const quickTitle = useRef<HTMLInputElement>(null)
  const quickError = useRef<HTMLParagraphElement>(null)
  const restoreNewFocus = useRef(false)
  const authRejected = useRef(false)
  const quickOpener = useRef<HTMLElement | null>(null)
  const loadGeneration = useRef(0)
  const today = dateKey(new Date().toISOString())!
  const writeAllowed = writableSource(apiStatus, online, source)
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects])
  const projectName = (task: TaskOut) => task.project_id ? projectNames.get(task.project_id) ?? 'Unavailable project' : ''

  // Cached reads remain useful, but cannot prove a live source: explicitly bypass
  // fallback first. A 401/403 never falls back to private cached records.
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setRefreshing(true)
    let nextTasks: readonly TaskOut[] | undefined
    let nextSource: typeof source = 'live'
    try { nextTasks = await getSharedApiClient().tasks(undefined, freshRead) }
    catch (error) {
      if (isAuthError(error)) nextSource = 'auth'
      else if (error instanceof ApiError && error.status < 500) nextSource = 'error'
      else {
        nextSource = 'cached'
        try { nextTasks = await getSharedApiClient().tasks() }
        catch (cachedError) { nextSource = isAuthError(cachedError) ? 'auth' : 'error' }
      }
    }
    let nextProjects: readonly ProjectResponse[] = []
    let unavailable = false
    if (nextSource !== 'auth') {
      try { nextProjects = await getSharedApiClient().projects(freshRead) }
      catch (error) {
        unavailable = true
        if (isAuthError(error)) nextSource = 'auth'
        else {
          try { nextProjects = await getSharedApiClient().projects() }
          catch (cachedError) { if (isAuthError(cachedError)) nextSource = 'auth' }
        }
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
  useEffect(() => { void load(); return () => { loadGeneration.current++ } }, [load, apiStatus])
  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); if (navigator.onLine) void load() }
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [load])

  const closeQuick = () => { if (pendingRef.current) return; setQuickOpen(false); (quickOpener.current?.isConnected && quickOpener.current !== quickTitle.current ? quickOpener.current : document.querySelector<HTMLElement>('.tasks-navigation [aria-selected="true"]'))?.focus() }
  const openQuick = () => {
    if (pendingRef.current) return
    quickOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuickOpen(true)
  }
  useEffect(() => { if (quickOpen) quickTitle.current?.focus() }, [quickOpen])
  useEffect(() => { if (quickOpen && createError && !pending) quickError.current?.focus() }, [quickOpen, createError, pending])
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
    if (routeIntent.create) { setEditor(null); setQuickOpen(true) }
    else {
      const task = tasks.find(item => item.id === routeIntent.task)!
      setQuickOpen(false); setEditor(editDrafts.current.get(task.id) ?? { task, draft: draftFromTask(task), error: '', conflict: false, latest: null })
      setConfirmDelete(false); setActionError('')
    }
    setRouteIntent(null)
  }, [routeIntent, tasks, source, pending, editor])
  const beginWrite = () => { if (pendingRef.current || !writeAllowed) return false; pendingRef.current = true; setPending(true); setMessage(''); setActionError(''); return true }
  const endWrite = () => { pendingRef.current = false; setPending(false) }
  const createTask = async (event: FormEvent) => {
    event.preventDefault()
    if (createUncertain) return
    let input
    try { input = draftToInput(newDraft) } catch (error) { setCreateError((error as Error).message); quickTitle.current?.focus(); return }
    if (!beginWrite()) return
    setCreateError('')
    try {
      const saved = await getSharedApiClient().createTask(input, { queueOnOffline: false, idempotencyKey: crypto.randomUUID() })
      upsert(saved); setNewDraft(emptyDraft()); setQuickOpen(false); setDetailsOpen(false)
      setView(saved.due_at ? 'all' : 'inbox'); setQuery(''); setProjectFilter('all'); setStatusFilter('all'); setHighOnly(false); setPriorityFilter('all'); setOverdueOnly(false)
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
  const inView = (task: TaskOut, target: TaskView) => target === 'all' ? true : target === 'completed' ? isCompleted(task) : !isCompleted(task) && (target === 'inbox' ? !task.due_at : target === 'today' ? !!task.due_at && dateKey(task.due_at)! <= today : !!task.due_at && dateKey(task.due_at)! > today)
  const viewTasks = tasks.filter(task => inView(task, view))
  const matching = viewTasks.filter(task => taskMatchesQuery(task, query, projectName(task)) && (projectFilter === 'all' || (projectFilter === 'none' ? !task.project_id : task.project_id === projectFilter)) && (statusFilter === 'all' || (statusFilter === 'completed' ? isCompleted(task) : !isCompleted(task))) && (priorityFilter === 'all' || task.priority === Number(priorityFilter)) && (!highOnly || task.priority >= 3) && (!overdueOnly || isOverdue(task)))
  const sortedTasks = [...matching].sort((a, b) => Number(isCompleted(a)) - Number(isCompleted(b)) || (a.due_at ?? '').localeCompare(b.due_at ?? '') || b.priority - a.priority || a.title.localeCompare(b.title))
  const groups = view === 'today' ? [{ key: 'overdue', label: 'Overdue', tasks: sortedTasks.filter(task => dateKey(task.due_at)! < today) }, { key: today, label: 'Today', tasks: sortedTasks.filter(task => dateKey(task.due_at) === today) }].filter(group => group.tasks.length) : view === 'inbox' || view === 'completed' ? sortedTasks.length ? [{ key: view, label: view === 'inbox' ? 'Inbox' : 'Completed', tasks: sortedTasks }] : [] : groupTasksByDay(sortedTasks)
  const activeFilters = !!query || statusFilter !== 'all' || projectFilter !== 'all' || highOnly || priorityFilter !== 'all' || overdueOnly
  const heading = VIEWS.find(item => item.id === view)?.label ?? 'All tasks'
  const groupTitle = (key: string) => key === 'overdue' ? 'Overdue' : key === 'inbox' ? 'Inbox' : key === 'completed' ? 'Completed' : key === today ? 'Today' : key ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${key}T12:00:00`)) : 'No date'
  const hiddenDrafts = editDrafts.current.size
  const offline = !online || apiStatus !== 'ready' || source === 'cached'
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowKey = dateKey(tomorrow.toISOString())
  const patchQuick = (patch: Partial<TaskDraft>) => setNewDraft(draft => ({ ...draft, ...patch }))
  const quickKeys = (event: ReactKeyboardEvent<HTMLFormElement>) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuick() } }

  return <div className="tasks-screen">

    {message && <p className="tasks-feedback" role="status">{message}</p>}
    {actionError && <p className="tasks-error" role="alert">{actionError}</p>}
    {source === 'loading' && <p role="status" className="tasks-source">Loading your tasks…</p>}
    {source === 'auth' && <p className="tasks-error" role="alert">Your session ended. Sign in again to load your private tasks.</p>}
    {source === 'error' && <div className="tasks-error" role="alert">Tasks could not be loaded. Previously loaded records may be out of date. <button type="button" disabled={refreshing} onClick={() => void load()}>Try again</button></div>}
    {offline && source !== 'loading' && source !== 'auth' && <p className="tasks-source" role="status">Offline or connection unavailable. Showing cached or previously loaded tasks. Saving requires a connection; drafts stay open while you work here.</p>}
    {projectsUnavailable && <p className="tasks-source" role="status">Projects could not be refreshed. Existing links are preserved; reconnect to choose a project.</p>}
    <div className="tasks-workspace">
      <div className="tasks-top-row"><div className="tasks-navigation" role="tablist" aria-label="Task views" onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = Math.max(0, VIEWS.findIndex(item => item.id === view))
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 4) % 4
        setView(VIEWS[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        {VIEWS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" aria-label={label} id={`tasks-tab-${id}`} aria-controls="tasks-panel" aria-selected={view === id} tabIndex={view === id || (view === 'all' && id === 'today') ? 0 : -1} onClick={() => setView(id)}><Icon size={18} /><span>{label}</span><b aria-hidden="true">{tasks.filter(task => inView(task, id)).length}</b></button>)}
      </div>
      <div className="tasks-tools">
        <label className="tasks-search"><Search size={18} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear search" className="tasks-icon" onClick={() => setQuery('')}><X size={16} /></button>}</label>
        <div className="tasks-tool-label tasks-priority-filter"><StyledSelect aria-label="Filter by priority" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}><option value="all">All priorities</option>{PRIORITIES.map((priority, index) => <option key={priority} value={index}>{priority}</option>)}</StyledSelect></div>
        <div className="tasks-tool-label tasks-project-filter"><StyledSelect aria-label="Filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option><option value="none">No project</option>{[...new Set([...projects.map(project => project.id), ...tasks.flatMap(task => task.project_id ? [task.project_id] : [])])].map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</StyledSelect></div>
        <details className="tasks-more-filters"><summary>More</summary><div className="tasks-more-panel"><div className="tasks-mobile-filters"><label>Search<input aria-label="Mobile search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} /></label><div>Priority<StyledSelect aria-label="Mobile filter by priority" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}><option value="all">All priorities</option>{PRIORITIES.map((priority, index) => <option key={priority} value={index}>{priority}</option>)}</StyledSelect></div><div>Project<StyledSelect aria-label="Mobile filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option><option value="none">No project</option>{[...new Set([...projects.map(project => project.id), ...tasks.flatMap(task => task.project_id ? [task.project_id] : [])])].map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</StyledSelect></div></div><button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>All tasks</button><button type="button" aria-pressed={highOnly} onClick={() => setHighOnly(value => !value)}><Flag size={15} />High priority</button><button type="button" aria-pressed={overdueOnly} onClick={() => { setOverdueOnly(value => !value); if (!overdueOnly) setView('all') }}>Overdue</button>{activeFilters && <button type="button" onClick={clearFilters}>Clear filters</button>}<div className="tasks-tool-label">Status<StyledSelect aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option></StyledSelect></div>
        <button type="button" aria-label="Refresh tasks" className="tasks-icon" disabled={refreshing || pending} onClick={() => void load()}><RefreshCw size={18} /></button>
        </div></details>
      </div></div>
    <form className={`tasks-quick${detailsOpen ? ' tasks-quick--details' : ''}`} aria-label="Quick add task" onSubmit={createTask} onKeyDown={quickKeys}>
      <div className="tasks-quick-main"><Plus size={20} /><input ref={quickTitle} aria-label={quickOpen ? 'New task title' : 'Add a task'} placeholder="Add a task — Enter to save, Q to focus" value={newDraft.title} required disabled={pending} onFocus={() => { if (!quickOpen) setQuickOpen(true) }} onChange={event => patchQuick({ title: event.target.value })} />
        <StyledSelect aria-label="Quick date" value={newDraft.dueDate === dateKey(new Date().toISOString()) ? 'today' : newDraft.dueDate === tomorrowKey ? 'tomorrow' : newDraft.dueDate ? 'custom' : 'none'} disabled={pending} onChange={event => { const date = new Date(); if (event.target.value === 'tomorrow') date.setDate(date.getDate() + 1); patchQuick({ dueDate: event.target.value === 'none' ? '' : dateKey(date.toISOString()) ?? '', dueTime: '' }) }}><option value="none">No date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option>{newDraft.dueDate && newDraft.dueDate !== dateKey(new Date().toISOString()) && newDraft.dueDate !== tomorrowKey && <option value="custom">{newDraft.dueDate}</option>}</StyledSelect>
        <StyledSelect aria-label="Quick priority" value={newDraft.priority} disabled={pending} onChange={event => patchQuick({ priority: event.target.value })}><option value="0">No priority</option><option value="3">High</option><option value="2">Medium</option><option value="1">Low</option></StyledSelect>
        <StyledSelect aria-label="Quick project" value={newDraft.projectId} disabled={pending || projectsUnavailable} onChange={event => patchQuick({ projectId: event.target.value })}><option value="">No project</option>{newDraft.projectId && !projects.some(project => project.id === newDraft.projectId) && <option value={newDraft.projectId}>Unavailable project</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</StyledSelect>
        <button className="tasks-primary" aria-label="Add task" type="submit" disabled={!writeAllowed || pending || !newDraft.title.trim() || createUncertain}>{pending ? 'Saving…' : 'Add'}</button>
      </div>
      {quickOpen && <div className="tasks-quick-extra"><button type="button" className="tasks-quiet" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? 'Hide details' : 'Add details'}</button><button type="button" aria-label="Close quick add" className="tasks-quiet" disabled={pending} onClick={closeQuick}>Close</button></div>}
      {detailsOpen && <div className="tasks-quick-fields">
        <label>Due date<input type="date" aria-label="New due date" value={newDraft.dueDate} disabled={pending} onChange={event => patchQuick({ dueDate: event.target.value, ...(!event.target.value ? { dueTime: '' } : {}) })} /></label>
        <label>Due time<input type="time" aria-label="New due time" value={newDraft.dueTime} disabled={pending || !newDraft.dueDate} onChange={event => patchQuick({ dueTime: event.target.value })} /></label>
        <p className="tasks-help">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}. A date without a time is due at 23:59.</p>
      </div>}
      {createError && <p ref={quickError} tabIndex={-1} className="tasks-error" role="alert">{createError}</p>}
      {createUncertain && <div className="tasks-recovery"><button type="button" disabled={pending || refreshing} onClick={async () => { if (await load()) { setCheckedUncertain(true); setView('all'); clearFilters() } }}>Check task list</button>{checkedUncertain && <><span>If it is already in the list, close this draft. Otherwise:</span><button type="button" onClick={() => { setCreateUncertain(false); setCreateError(''); setCheckedUncertain(false) }}>Allow another attempt</button></>}</div>}
    </form>
      <section role="tabpanel" id="tasks-panel" aria-labelledby={view === 'all' ? undefined : `tasks-tab-${view}`} aria-label={view === 'all' ? 'All tasks' : undefined} tabIndex={0}>
        <header className="tasks-list-heading"><div><h3>{heading}</h3>{view === 'inbox' && <p>Without a due date</p>}{view === 'upcoming' && <p>After today</p>}</div>{!quickOpen && newDraft.title && <button type="button" className="tasks-quiet" onClick={openQuick}>Resume new task</button>}</header>
        {hiddenDrafts > 0 && <div className="tasks-draft-shelf"><span>Unsent edits</span>{[...editDrafts.current.values()].map(saved => <button type="button" key={saved.task.id} onClick={() => setEditor(saved)}>{saved.draft.title || saved.task.title}</button>)}</div>}
        {groups.map(group => <section className="tasks-date-group" key={group.key} aria-label={groupTitle(group.key)}>
          <h4>{groupTitle(group.key)} <span>{group.tasks.length}</span>{group.key === today && <time className="tasks-group-date" dateTime={today}>{new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</time>}</h4>
          <ul>{group.tasks.map(task => <li data-task-row={task.id} className={`tasks-item${isCompleted(task) ? ' tasks-item--done' : ''}`} key={task.id}>
            <button type="button" role="checkbox" aria-checked={isCompleted(task)} aria-label={`${isCompleted(task) ? 'Reopen' : 'Complete'} ${task.title}`} className="tasks-check" disabled={pending || !writeAllowed} onClick={() => void toggle(task)}><span>{isCompleted(task) && <Check size={14} />}</span></button>
            <button type="button" className="tasks-open" aria-label={`Open task: ${task.title}`} data-task-editor-trigger onClick={() => openEditor(task)} disabled={pending}><span className="tasks-label"><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}</span></button><span className="tasks-row-meta">{task.project_id && <span><Folder size={13} />{projectName(task)}</span>}{task.status === 'in_progress' && <span>In progress</span>}</span>
            <time className={isOverdue(task) ? 'tasks-due tasks-due--overdue' : 'tasks-due'} dateTime={task.due_at ?? undefined}>{task.due_at && dateKey(task.due_at) === today && <Clock size={12} aria-hidden="true" />}{task.due_at ? new Intl.DateTimeFormat(undefined, dateKey(task.due_at) === today ? { hour:'2-digit', minute:'2-digit', hour12:false } : { month:'short', day:'numeric' }).format(new Date(task.due_at)) : 'No date'}</time>
            <button type="button" className="tasks-icon tasks-priority" data-priority={task.priority >= 3 ? 'high' : task.priority === 2 ? 'medium' : 'low'} title={`${PRIORITIES[task.priority] ?? task.priority} priority`} aria-label={`Change priority: ${task.title}`} onClick={() => openEditor(task)} disabled={pending}>{task.priority > 0 && <Flag size={15} />}</button>
            <button type="button" className="tasks-icon tasks-row-more" aria-label={`Task details: ${task.title}`} onClick={() => openEditor(task)} disabled={pending}><Ellipsis size={18} /></button>
          </li>)}</ul>
        </section>)}
        {!groups.length && source !== 'loading' && source !== 'auth' && source !== 'error' && <div className="tasks-empty"><Inbox size={32} /><h4>{activeFilters ? 'No matches in this view' : `No ${view === 'all' ? '' : view + ' '}tasks`}</h4>{activeFilters && <p>Adjust your filters or look in All tasks.</p>}{activeFilters ? <button type="button" onClick={() => { clearFilters(); setView('all') }}>Show all tasks</button> : <button type="button" onClick={openQuick}>Add a task</button>}</div>}
      </section>
    </div>
    {editor && <TaskEditor value={editor.draft} onChange={draft => setEditor({ ...editor, draft })} task={editor.task} projects={projects} projectsUnavailable={projectsUnavailable} pending={pending} saveDisabled={!writeAllowed || editor.conflict} error={editor.error} onSave={() => void saveEditor()} onClose={closeEditor} dirty={JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task))} onRevert={() => { editDrafts.current.delete(editor.task.id); setEditor({ ...editor, draft: draftFromTask(editor.task), error: editor.conflict ? editor.error : '' }); setConfirmDelete(false) }} confirmDelete={confirmDelete} onDelete={() => { if (confirmDelete) void deleteEditor(); else setConfirmDelete(true) }} onCancelDelete={() => setConfirmDelete(false)} deleteDisabled={!writeAllowed || editor.conflict} notice={<>
      {!writeAllowed && <p className="tasks-source">Saving requires a connection. You can keep editing this draft.</p>}
      <p className="task-editor__help">Closing keeps your draft here until you leave Tasks. {editor.task.rrule ? 'Existing recurrence is preserved.' : ''}</p>
      {editor.conflict && <div className="tasks-conflict"><p>This task changed elsewhere. Compare before replacing its fields.</p><button type="button" disabled={pending || !writeAllowed} onClick={() => void compareLatest()}>Compare latest</button>{editor.latest && <><h3>Latest saved version</h3><dl><dt>Title</dt><dd>{editor.latest.title}</dd><dt>Description</dt><dd>{editor.latest.description || 'None'}</dd><dt>Date</dt><dd>{editor.latest.due_at ? new Date(editor.latest.due_at).toLocaleString() : 'No date'}</dd><dt>Priority</dt><dd>{PRIORITIES[editor.latest.priority] ?? editor.latest.priority}</dd><dt>Project</dt><dd>{projectName(editor.latest) || 'None'}</dd><dt>Status</dt><dd>{editor.latest.status}</dd></dl><p>Keep my draft replaces these fields when you save. Parent and recurrence keep the latest saved values.</p><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ ...editor, fieldBase: editor.fieldBase ?? editor.task, task: latest, conflict: false, latest: null, error: '' }) }}>Keep my draft</button><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ task: latest, draft: draftFromTask(latest), conflict: false, latest: null, error: '' }) }}>Use latest version</button></>}</div>}
    </>} />}
  </div>
}
