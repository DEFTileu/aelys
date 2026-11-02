import { Calendar, CalendarDays, Check, CircleCheck, CircleCheckBig, CirclePlus, Clock, Ellipsis, Flag, Inbox, Search } from '../../icons'
import { PageSkeleton } from '../../components/PageSkeleton'
import type { ApiStatus } from '../../types'
import { dateKey, fmtDay, isCompleted, isOverdue, parseQuickTokens, projectColor } from './taskModel'
import { TaskEditorPanel } from './TaskEditorPanel'
import { PRIORITIES, useTasks, type TaskView } from './useTasks'

const VIEWS = [{ id: 'inbox', label: 'Inbox', Icon: Inbox }, { id: 'today', label: 'Today', Icon: Calendar }, { id: 'upcoming', label: 'Upcoming', Icon: CalendarDays }, { id: 'completed', label: 'Completed', Icon: CircleCheck }] as const
const PRIORITY_COLORS = ['', '#2F6FE4', '#D97706', '#D93636']

export function TasksDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useTasks(apiStatus)
  const { message, actionError, source, refreshing, load, offline, projectsUnavailable, tasks, view, setView, inView, query, setQuery, projectFilter, setProjectFilter, statusFilter, setStatusFilter, highOnly, setHighOnly, priorityFilter, setPriorityFilter, overdueOnly, setOverdueOnly, moreOpen, setMoreOpen, moreRef, clearFilters, pending, projectNames, projectName, projects, projectIds, newDraft, patchQuick, tokenPatch, writeAllowed, createTask, quickTitle, createError, quickError, createUncertain, checkedUncertain, setCheckedUncertain, setCreateUncertain, setCreateError, hiddenDrafts, editDrafts, setEditor, editor, groups, groupTitle, groupSub, whenFor, today, toggle, openEditor, emptyTitle, activeFilters, sortedTasks, newDateValue, pickNewDate, quickKeys, priorityOptions, filterCount } = t
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
      <div className="tasks-top-row">
        <div className="tasks-navigation" role="tablist" aria-label="Task views" onKeyDown={event => {
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = Math.max(0, VIEWS.findIndex(item => item.id === view))
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length
          setView(VIEWS[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>
          {VIEWS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" aria-label={label} id={`tasks-tab-${id}`} aria-controls="tasks-panel" aria-selected={view === id} tabIndex={view === id || ((view === 'all' || view === 'matrix') && id === 'today') ? 0 : -1} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span><b aria-hidden="true">{tasks.filter(task => inView(task, id)).length}</b></button>)}
        </div>
        <span className="tasks-spacer" />
        <label className="tasks-search"><Search size={16} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="tasks-more" ref={moreRef}>
            <button type="button" className="tasks-more-button" aria-label="More views and filters" aria-haspopup="true" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><Ellipsis size={18} /></button>
            {moreOpen && <div className="tasks-more-panel">
              <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>All tasks</button>
              <button type="button" aria-pressed={view === 'matrix'} onClick={() => setView('matrix')}>Matrix</button>
              <button type="button" aria-pressed={highOnly} onClick={() => setHighOnly(value => !value)}><Flag size={15} />High priority</button>
              <button type="button" aria-pressed={overdueOnly} onClick={() => { setOverdueOnly(value => !value); if (!overdueOnly) setView('all') }}>Overdue</button>
              <div className="tasks-more-status">Status<select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option></select></div>
              {activeFilters && <button type="button" onClick={clearFilters}>Clear filters</button>}
              <button type="button" aria-label="Refresh tasks" disabled={refreshing || pending} onClick={() => void load()}>Refresh</button>
            </div>}
          </div>
        </label>
        <select className="tasks-select" aria-label="Filter by priority" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}>{priorityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select className="tasks-select" aria-label="Filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option><option value="none">No project</option>{projectIds.map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</select>
        {filterCount > 0 && <button type="button" className="tasks-reset" onClick={() => { setPriorityFilter('all'); setProjectFilter('all'); setQuery('') }}>Reset</button>}
      </div>
      <form className="tasks-quick" aria-label="Quick add task" onSubmit={createTask} onKeyDown={quickKeys}>
        <CirclePlus size={20} className="tasks-quick-icon" />
        <input ref={quickTitle} aria-label="Add a task" aria-describedby="tasks-quick-hint" placeholder="Add a task — Enter to save, Q to focus" value={newDraft.title} disabled={pending} onChange={event => { const parsed = parseQuickTokens(event.target.value, projects, new Date(), false); patchQuick(tokenPatch(parsed, newDraft)) }} />
        <span id="tasks-quick-hint" className="tasks-sr">Try @tomorrow, @14:30, !p1 or #project</span>
        <select className="tasks-quick-select" aria-label="Date" value={newDateValue} disabled={pending} onChange={event => pickNewDate(event.target.value)}><option value="none">No date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option>{!['none', 'today', 'tomorrow'].includes(newDateValue) && <option value={newDateValue}>{fmtDay(newDateValue, today)}</option>}</select>
        <select className="tasks-quick-select" aria-label="Priority" value={newDraft.priority} disabled={pending} onChange={event => patchQuick({ priority: event.target.value })}><option value="0">No priority</option><option value="3">High</option><option value="2">Medium</option><option value="1">Low</option></select>
        <select className="tasks-quick-select tasks-quick-project" aria-label="Project" value={newDraft.projectId} disabled={pending} onChange={event => patchQuick({ projectId: event.target.value })}><option value="">No project</option>{projectIds.map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</select>
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
                <button type="button" className="tasks-open" aria-label={`Open task: ${task.title}`} data-task-editor-trigger onClick={event => { event.stopPropagation(); openEditor(task) }} disabled={pending}><span className="tasks-label"><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}</span></button>
                {task.project_id && <span className="tasks-project" style={{ color, background: `${color}1A` }}>{projectName(task)}</span>}
                {task.status === 'in_progress' && <span className="tasks-project tasks-status">In progress</span>}
                {when && <time className={`tasks-due${overdue ? ' tasks-due--overdue' : ''}`} dateTime={task.due_at ?? undefined}><Clock size={12} aria-hidden="true" />{when}</time>}
                <span className="tasks-priority" title={task.priority > 0 ? `${PRIORITIES[task.priority] ?? task.priority} priority` : undefined}>{task.priority > 0 && <Flag size={15} style={{ color: PRIORITY_COLORS[task.priority] || PRIORITY_COLORS[3] }} />}</span>
              </li>
            })}</ul>
          </section>)}
        </div>
        {!sortedTasks.length && source !== 'loading' && source !== 'auth' && source !== 'error' && <div className="tasks-empty"><span className="tasks-empty-icon"><CircleCheckBig size={24} /></span><p>{emptyTitle}</p><small>{activeFilters ? 'Try a different search or reset filters.' : 'Add a task above — press Q to jump to the field.'}</small>{activeFilters && <button type="button" onClick={() => { clearFilters(); setView('all') }}>Show all tasks</button>}</div>}
      </section>
    </div>
    <TaskEditorPanel {...t} />
  </div>
}
