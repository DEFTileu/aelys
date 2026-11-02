import { useState } from 'react'
import { StyledSelect } from '../../components/controls/StyledSelect'
import { Check, Flag, Folder, Plus, Search, X } from '../../icons'
import type { ApiStatus } from '../../types'
import { isCompleted, isOverdue, parseQuickTokens } from './taskModel'
import { TaskEditorPanel } from './TaskEditorPanel'
import { PRIORITIES, useTasks } from './useTasks'
import './tasks-mobile.css'

const TABS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['inbox', 'Inbox'], ['completed', 'Done']] as const

export function TasksMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useTasks(apiStatus)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const { message, actionError, source, refreshing, load, offline, projectsUnavailable, tasks, view, setView, inView, query, setQuery, projectFilter, setProjectFilter, statusFilter, setStatusFilter, highOnly, setHighOnly, priorityFilter, setPriorityFilter, overdueOnly, setOverdueOnly, projects, projectNames, projectName, projectIds, priorityOptions, activeFilters, clearFilters, groups, groupTitle, whenFor, emptyTitle, pending, newDraft, patchQuick, tokenPatch, createTask, writeAllowed, quickTitle, createError, createUncertain, setCreateUncertain, checkedUncertain, setCheckedUncertain, setCreateError, toggle, openEditor, hiddenDrafts, editDrafts, setEditor } = t

  return <div className="tasks-m">
    {message && <p className="tasks-feedback" role="status">{message}</p>}
    {actionError && <p className="tasks-error" role="alert">{actionError}</p>}
    {source === 'loading' && <p className="tasks-source" role="status">Loading your tasks…</p>}
    {source === 'auth' && <p className="tasks-error" role="alert">Your session ended. Sign in again to load your private tasks.</p>}
    {source === 'error' && <div className="tasks-error" role="alert">Tasks could not be loaded. <button type="button" disabled={refreshing} onClick={() => void load()}>Try again</button></div>}
    {offline && source !== 'loading' && source !== 'auth' && <p className="tasks-source" role="status">Offline. Showing cached tasks; saving needs a connection.</p>}
    {projectsUnavailable && <p className="tasks-source" role="status">Projects could not be refreshed. Existing links are preserved.</p>}

    <div className="tasks-m-views" role="tablist" aria-label="Task views">
      {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>
        {label}<b>{tasks.filter(task => inView(task, id)).length}</b>
      </button>)}
    </div>

    <div className="tasks-m-tools">
      <label className="tasks-m-search"><Search size={18} aria-hidden="true" /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}</label>
      <button type="button" className="tasks-m-filter-btn" aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>Filters{activeFilters && <i aria-label="Filters active" />}</button>
    </div>

    <form className="tasks-m-add" aria-label="Quick add task" onSubmit={createTask}>
      <Plus size={20} aria-hidden="true" />
      <input ref={quickTitle} aria-label="Add a task" placeholder="Add a task — try @tomorrow or !p1" value={newDraft.title} disabled={pending} onChange={event => patchQuick(tokenPatch(parseQuickTokens(event.target.value, projects, new Date(), false), newDraft))} />
      <button type="submit" aria-label="Add task" disabled={!writeAllowed || pending || createUncertain || !newDraft.title.trim()}>{pending ? 'Saving…' : 'Add'}</button>
      {createError && <p className="tasks-error" role="alert">{createError}</p>}
      {createUncertain && <div className="tasks-m-recovery">
        <button type="button" disabled={pending || refreshing} onClick={async () => { if (await load()) { setCheckedUncertain(true); setView('all'); clearFilters() } }}>Check task list</button>
        {checkedUncertain && <><span>If it is already in the list, close this draft. Otherwise:</span><button type="button" onClick={() => { setCreateUncertain(false); setCreateError(''); setCheckedUncertain(false) }}>Allow another attempt</button></>}
      </div>}
    </form>

    {hiddenDrafts > 0 && <div className="tasks-m-drafts"><span>Unsent edits</span>{[...editDrafts.current.values()].map(saved => <button type="button" key={saved.task.id} onClick={() => setEditor(saved)}>{saved.draft.title || saved.task.title}</button>)}</div>}

    {groups.map(group => <section className="tasks-m-group" key={group.key} aria-label={groupTitle(group.key)}>
      <h4>{groupTitle(group.key)} <span>{group.tasks.length}</span></h4>
      <ul>{group.tasks.map(task => <li key={task.id} data-task-row={task.id} className={`tasks-m-item${isCompleted(task) ? ' tasks-m-item--done' : ''}`}>
        <button type="button" role="checkbox" aria-checked={isCompleted(task)} aria-label={`${isCompleted(task) ? 'Reopen' : 'Complete'} ${task.title}`} className="tasks-m-check" disabled={pending || !writeAllowed} onClick={() => void toggle(task)}>{isCompleted(task) && <Check size={14} />}</button>
        <button type="button" className="tasks-m-open" aria-label={`Open task: ${task.title}`} disabled={pending} onClick={() => openEditor(task)}>
          <strong>{task.title}</strong>
          <small>
            {whenFor(task) && <time className={isOverdue(task) ? 'tasks-m-due tasks-m-due--overdue' : 'tasks-m-due'} dateTime={task.due_at ?? undefined}>{whenFor(task)}</time>}
            {task.project_id && <span><Folder size={12} aria-hidden="true" />{projectName(task)}</span>}
            {task.priority > 0 && <span title={`${PRIORITIES[task.priority] ?? task.priority} priority`}><Flag size={13} aria-hidden="true" /></span>}
          </small>
        </button>
      </li>)}</ul>
    </section>)}

    {!groups.length && source !== 'loading' && source !== 'auth' && source !== 'error' && <div className="tasks-m-empty">
      <h4>{emptyTitle}</h4>
      {activeFilters && <button type="button" onClick={() => { clearFilters(); setView('all') }}>Show all tasks</button>}
    </div>}

    <button type="button" className="tasks-m-fab" aria-label="New task" onClick={() => quickTitle.current?.focus()}><Plus size={24} /></button>

    {filtersOpen && <div className="tasks-m-scrim" onClick={() => setFiltersOpen(false)} />}
    {filtersOpen && <section className="tasks-m-sheet" role="dialog" aria-modal="true" aria-label="Filters">
      <label>Priority<StyledSelect aria-label="Filter by priority" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}>{priorityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</StyledSelect></label>
      <label>Project<StyledSelect aria-label="Filter by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option><option value="none">No project</option>{projectIds.map(id => <option key={id} value={id}>{projectNames.get(id) ?? 'Unavailable project'}</option>)}</StyledSelect></label>
      <label>Status<StyledSelect aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option></StyledSelect></label>
      <button type="button" aria-pressed={highOnly} onClick={() => setHighOnly(value => !value)}><Flag size={15} aria-hidden="true" />High priority</button>
      <button type="button" aria-pressed={overdueOnly} onClick={() => { setOverdueOnly(value => !value); if (!overdueOnly) setView('all') }}>Overdue</button>
      <div className="tasks-m-sheet__actions">
        <button type="button" onClick={clearFilters}>Clear</button>
        <button type="button" className="tasks-m-primary" onClick={() => setFiltersOpen(false)}>Done</button>
      </div>
    </section>}

    <TaskEditorPanel {...t} />
  </div>
}
