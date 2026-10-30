import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ApiError, type ProjectResponse, type TaskOut } from '@aelys/shared'
import { Calendar, CalendarDays, Check, Ellipsis, Flag, Folder, Inbox, ListChecks, Plus, RefreshCw, Search, X } from '../icons'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import { TaskEditor } from './tasks/TaskEditor'
import { dateKey, draftFromTask, draftToInput, emptyDraft, fullTaskInput, groupTasksByDay, isCompleted, isOverdue, taskMatchesQuery, type TaskDraft } from './tasks/taskModel'
import './desktop/tasks.css'

type TaskView = 'inbox' | 'today' | 'upcoming' | 'all'
type EditorState = { task: TaskOut; draft: TaskDraft; error: string; conflict: boolean; latest: TaskOut | null; fieldBase?: TaskOut }
const VIEWS = [{ id: 'inbox', label: 'Inbox', Icon: Inbox }, { id: 'today', label: 'Today', Icon: Calendar }, { id: 'upcoming', label: 'Upcoming', Icon: CalendarDays }, { id: 'all', label: 'All tasks', Icon: ListChecks }] as const
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
  const [view, setView] = useState<TaskView>('inbox')
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [highOnly, setHighOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [newDraft, setNewDraft] = useState<TaskDraft>(emptyDraft)
  const [createError, setCreateError] = useState('')
  const [createUncertain, setCreateUncertain] = useState(false)
  const [checkedUncertain, setCheckedUncertain] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const editDrafts = useRef(new Map<string, EditorState>())
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const quickTitle = useRef<HTMLInputElement>(null)
  const quickError = useRef<HTMLParagraphElement>(null)
  const restoreNewFocus = useRef(false)
  const authRejected = useRef(false)
  const newButton = useRef<HTMLButtonElement>(null)
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

  const closeQuick = () => { if (pendingRef.current) return; setQuickOpen(false); (quickOpener.current?.isConnected ? quickOpener.current : newButton.current)?.focus() }
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

  useEffect(() => { if (!pending && restoreNewFocus.current) { restoreNewFocus.current = false; newButton.current?.focus() } }, [pending])
  const upsert = (task: TaskOut) => { if (authRejected.current) return; loadGeneration.current++; setRefreshing(false); setTasks(items => items.some(item => item.id === task.id) ? items.map(item => item.id === task.id ? task : item) : [...items, task]) }
  const closeEditor = () => {
    if (pendingRef.current || !editor) return
    if (JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task)) || editor.error) editDrafts.current.set(editor.task.id, editor)
    else editDrafts.current.delete(editor.task.id)
    setEditor(null)
  }
  const openEditor = (task: TaskOut) => {
    if (pendingRef.current) return
    setMessage(''); setActionError('')
    setEditor(editDrafts.current.get(task.id) ?? { task, draft: draftFromTask(task), error: '', conflict: false, latest: null })
  }
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
      setView(saved.due_at ? 'all' : 'inbox'); setQuery(''); setProjectFilter('all'); setStatusFilter('all'); setHighOnly(false); setOverdueOnly(false)
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
  const clearFilters = () => { setQuery(''); setStatusFilter('all'); setProjectFilter('all'); setHighOnly(false); setOverdueOnly(false) }
  const viewTasks = tasks.filter(task => view === 'all' || (view === 'inbox' ? !task.due_at : view === 'today' ? dateKey(task.due_at) === today : !!task.due_at && dateKey(task.due_at)! > today))
  const matching = viewTasks.filter(task => taskMatchesQuery(task, query, projectName(task)) && (projectFilter === 'all' || (projectFilter === 'none' ? !task.project_id : task.project_id === projectFilter)) && (statusFilter === 'all' || (statusFilter === 'completed' ? isCompleted(task) : !isCompleted(task))) && (!highOnly || task.priority >= 3) && (!overdueOnly || isOverdue(task)))
  const groups = groupTasksByDay([...matching].sort((a, b) => Number(isCompleted(a)) - Number(isCompleted(b)) || (a.due_at ?? '').localeCompare(b.due_at ?? '') || b.priority - a.priority || a.title.localeCompare(b.title)))
  const activeFilters = !!query || statusFilter !== 'all' || projectFilter !== 'all' || highOnly || overdueOnly
  const heading = VIEWS.find(item => item.id === view)!.label
  const groupTitle = (key: string) => key === today ? 'Today' : key ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${key}T12:00:00`)) : 'No date'
  const hiddenDrafts = editDrafts.current.size
  const offline = !online || apiStatus !== 'ready' || source === 'cached'
  const patchQuick = (patch: Partial<TaskDraft>) => setNewDraft(draft => ({ ...draft, ...patch }))
  const quickKeys = (event: ReactKeyboardEvent<HTMLFormElement>) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuick() } }

  return <div className="tasks-screen">
    <header className="tasks-workspace-head">
      <h1>Tasks</h1>
      <button ref={newButton} type="button" data-task-editor-trigger aria-label="New task" className="tasks-primary" onClick={openQuick} disabled={pending}><Plus size={18} />New task <kbd>Q</kbd></button>
    </header>
    {message && <p className="tasks-feedback" role="status">{message}</p>}
    {actionError && <p className="tasks-error" role="alert">{actionError}</p>}
    {source === 'loading' && <p role="status" className="tasks-source">Loading your tasks…</p>}
    {source === 'auth' && <p className="tasks-error" role="alert">Your session ended. Sign in again to load your private tasks.</p>}
    {source === 'error' && <div className="tasks-error" role="alert">Tasks could not be loaded. Previously loaded records may be out of date. <button type="button" disabled={refreshing} onClick={() => void load()}>Try again</button></div>}
    {offline && source !== 'loading' && source !== 'auth' && <p className="tasks-source" role="status">Offline or connection unavailable. Showing cached or previously loaded tasks. Saving requires a connection; drafts stay open while you work here.</p>}
    {projectsUnavailable && <p className="tasks-source" role="status">Projects could not be refreshed. Existing links are preserved; reconnect to choose a project.</p>}
    <div className="tasks-workspace">
      <div className="tasks-navigation" role="tablist" aria-label="Task views" onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = VIEWS.findIndex(item => item.id === view)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 4) % 4
        setView(VIEWS[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        {VIEWS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" aria-label={label} id={`tasks-tab-${id}`} aria-controls="tasks-panel" aria-selected={view === id} tabIndex={view === id ? 0 : -1} onClick={() => setView(id)}><Icon size={18} /><span>{label}</span><b aria-hidden="true">{tasks.filter(task => id === 'all' || (id === 'inbox' ? !task.due_at : id === 'today' ? dateKey(task.due_at) === today : !!task.due_at && dateKey(task.due_at)! > today)).length}</b></button>)}
      </div>
      <div className="tasks-tools">
        <label className="tasks-search"><Search size={18} /><input aria-label="Search tasks" placeholder="Search title, notes or project" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear search" className="tasks-icon" onClick={() => setQuery('')}><X size={16} /></button>}</label>
        <label className="tasks-tool-label">Project<select aria-label="Filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option><option value="none">No project</option>{[...new Set([...projects.map(project => project.id), ...tasks.flatMap(task => task.project_id ? [task.project_id] : [])])].map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</select></label>
        <label className="tasks-tool-label">Status<select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option></select></label>
        <button type="button" aria-label="Refresh tasks" className="tasks-icon" disabled={refreshing || pending} onClick={() => void load()}><RefreshCw size={18} /></button>
      </div>
    {!quickOpen && <button type="button" className="tasks-quick-trigger" onClick={openQuick} disabled={pending}><Plus size={20} /><span>{newDraft.title ? `Resume: ${newDraft.title}` : 'Add a task'}</span><b>Add</b></button>}
    {quickOpen && <form className="tasks-quick" aria-label="Quick add task" onSubmit={createTask} onKeyDown={quickKeys}>
      <div className="tasks-quick-line"><Plus size={20} /><input ref={quickTitle} aria-label="New task title" placeholder="What needs to get done?" value={newDraft.title} required disabled={pending} onChange={event => patchQuick({ title: event.target.value })} /><button type="button" aria-label="Close quick add" className="tasks-icon" disabled={pending} onClick={closeQuick}><X size={18} /></button></div>
      {detailsOpen && <div className="tasks-quick-fields">
        <label>Due date<input type="date" aria-label="New due date" value={newDraft.dueDate} disabled={pending} onChange={event => patchQuick({ dueDate: event.target.value, ...(!event.target.value ? { dueTime: '' } : {}) })} /></label>
        <label>Due time<input type="time" aria-label="New due time" value={newDraft.dueTime} disabled={pending || !newDraft.dueDate} onChange={event => patchQuick({ dueTime: event.target.value })} /></label>
        <label>Priority<select aria-label="New priority" value={newDraft.priority} disabled={pending} onChange={event => patchQuick({ priority: event.target.value })}>{PRIORITIES.map((priority, i) => <option key={priority} value={i}>{priority}</option>)}</select></label>
        <label>Project<select aria-label="New project" value={newDraft.projectId} disabled={pending || projectsUnavailable} onChange={event => patchQuick({ projectId: event.target.value })}><option value="">None</option>{newDraft.projectId && !projects.some(project => project.id === newDraft.projectId) && <option value={newDraft.projectId}>Unavailable project</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <p className="tasks-help">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}. A date without a time is due at 23:59.</p>
      </div>}
      {createError && <p ref={quickError} tabIndex={-1} className="tasks-error" role="alert">{createError}</p>}
      {createUncertain && <div className="tasks-recovery"><button type="button" disabled={pending || refreshing} onClick={async () => { if (await load()) { setCheckedUncertain(true); setView('all'); clearFilters() } }}>Check task list</button>{checkedUncertain && <><span>If it is already in the list, close this draft. Otherwise:</span><button type="button" onClick={() => { setCreateUncertain(false); setCreateError(''); setCheckedUncertain(false) }}>Allow another attempt</button></>}</div>}
      <footer><button type="button" className="tasks-quiet" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? 'Hide details' : 'Add details'}</button><span className="tasks-help">Enter to add · Esc keeps your draft</span><button className="tasks-primary" type="submit" disabled={!writeAllowed || pending || !newDraft.title.trim() || createUncertain}>{pending ? 'Saving…' : 'Add task'}</button></footer>
    </form>}
      <div className="tasks-filter-bar"><button type="button" aria-pressed={highOnly} onClick={() => setHighOnly(value => !value)}><Flag size={15} />High priority</button><button type="button" aria-pressed={overdueOnly} onClick={() => { setOverdueOnly(value => !value); if (!overdueOnly) setView('all') }} >Overdue</button>{activeFilters && <button type="button" className="tasks-quiet" onClick={clearFilters}>Clear filters</button>}<span className="tasks-result-count" role="status">{matching.length} {matching.length === 1 ? 'task' : 'tasks'}</span></div>
      <section role="tabpanel" id="tasks-panel" aria-labelledby={`tasks-tab-${view}`} tabIndex={0}>
        <header className="tasks-list-heading"><div><h3>{heading}</h3>{view === 'inbox' && <p>Without a due date</p>}{view === 'upcoming' && <p>After today</p>}</div>{!quickOpen && newDraft.title && <button type="button" className="tasks-quiet" onClick={openQuick}>Resume new task</button>}</header>
        {hiddenDrafts > 0 && <div className="tasks-draft-shelf"><span>Unsent edits</span>{[...editDrafts.current.values()].map(saved => <button type="button" key={saved.task.id} onClick={() => setEditor(saved)}>{saved.draft.title || saved.task.title}</button>)}</div>}
        {groups.map(group => <section className="tasks-date-group" key={group.key} aria-label={groupTitle(group.key)}>
          <h4>{groupTitle(group.key)}</h4>
          <ul>{group.tasks.map(task => <li data-task-row={task.id} className={`tasks-item${isCompleted(task) ? ' tasks-item--done' : ''}`} key={task.id}>
            <button type="button" role="checkbox" aria-checked={isCompleted(task)} aria-label={`${isCompleted(task) ? 'Reopen' : 'Complete'} ${task.title}`} className="tasks-check" disabled={pending || !writeAllowed} onClick={() => void toggle(task)}><span>{isCompleted(task) && <Check size={14} />}</span></button>
            <button type="button" className="tasks-open" aria-label={`Open task: ${task.title}`} data-task-editor-trigger onClick={() => openEditor(task)} disabled={pending}><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}<span className="tasks-row-meta">{task.project_id && <span><Folder size={13} />{projectName(task)}</span>}{task.status === 'in_progress' && <span>In progress</span>}</span></button>
            <time className={isOverdue(task) ? 'tasks-due tasks-due--overdue' : 'tasks-due'} dateTime={task.due_at ?? undefined}>{task.due_at ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(task.due_at)) : 'No date'}</time>
            <button type="button" className="tasks-icon tasks-priority" data-priority={task.priority >= 3 ? 'high' : task.priority === 2 ? 'medium' : 'low'} title={`${PRIORITIES[task.priority] ?? task.priority} priority`} aria-label={`Change priority: ${task.title}`} onClick={() => openEditor(task)} disabled={pending}><Flag size={17} /></button>
            <button type="button" className="tasks-icon" aria-label={`Task details: ${task.title}`} onClick={() => openEditor(task)} disabled={pending}><Ellipsis size={18} /></button>
          </li>)}</ul>
        </section>)}
        {!groups.length && source !== 'loading' && source !== 'auth' && source !== 'error' && <div className="tasks-empty"><Inbox size={32} /><h4>{activeFilters ? 'No matches in this view' : `No ${view === 'all' ? '' : view + ' '}tasks`}</h4>{activeFilters && <p>Adjust your filters or look in All tasks.</p>}{activeFilters ? <button type="button" onClick={() => { clearFilters(); setView('all') }}>Show all tasks</button> : <button type="button" onClick={openQuick}>Add a task</button>}</div>}
      </section>
    </div>
    {editor && <TaskEditor value={editor.draft} onChange={draft => setEditor({ ...editor, draft })} task={editor.task} projects={projects} projectsUnavailable={projectsUnavailable} pending={pending} saveDisabled={!writeAllowed || editor.conflict} error={editor.error} onSave={() => void saveEditor()} onClose={closeEditor} notice={<>
      {!writeAllowed && <p className="tasks-source">Saving requires a connection. You can keep editing this draft.</p>}
      <p className="task-editor__help">Closing keeps your draft here until you leave Tasks. {editor.task.rrule ? 'Existing recurrence is preserved.' : ''}</p>
      {editor.conflict && <div className="tasks-conflict"><p>This task changed elsewhere. Compare before replacing its fields.</p><button type="button" disabled={pending || !writeAllowed} onClick={() => void compareLatest()}>Compare latest</button>{editor.latest && <><h3>Latest saved version</h3><dl><dt>Title</dt><dd>{editor.latest.title}</dd><dt>Description</dt><dd>{editor.latest.description || 'None'}</dd><dt>Date</dt><dd>{editor.latest.due_at ? new Date(editor.latest.due_at).toLocaleString() : 'No date'}</dd><dt>Priority</dt><dd>{PRIORITIES[editor.latest.priority] ?? editor.latest.priority}</dd><dt>Project</dt><dd>{projectName(editor.latest) || 'None'}</dd><dt>Status</dt><dd>{editor.latest.status}</dd></dl><p>Keep my draft replaces these fields when you save. Parent and recurrence keep the latest saved values.</p><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ ...editor, fieldBase: editor.fieldBase ?? editor.task, task: latest, conflict: false, latest: null, error: '' }) }}>Keep my draft</button><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ task: latest, draft: draftFromTask(latest), conflict: false, latest: null, error: '' }) }}>Use latest version</button></>}</div>}
    </>} />}
  </div>
}
