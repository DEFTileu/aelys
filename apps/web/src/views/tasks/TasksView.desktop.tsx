import { Check, CircleCheckBig, CirclePlus, Clock, Flag, ListFilter, Search } from '../../icons'
import { MobileHeader } from '../../components/MobileHeader'
import type { ApiStatus } from '../../types'
import { TaskEditor } from './TaskEditor'
import { dateKey, fmtDay, projectColor, draftFromTask, parseQuickTokens, isCompleted, isOverdue } from './taskModel'
import { PageSkeleton } from '../../components/PageSkeleton'
import '../desktop/page-tokens.css'
import '../desktop/tasks.css'
import { PRIORITIES, PRIORITY_COLORS, VIEWS, useTasks } from './useTasks'

export function TasksDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const { editor, message, actionError, source, tasks, load, refreshing, offline, projectsUnavailable, today, view, setView, inView, query, setQuery, moreRef, moreOpen, setMoreOpen, activeFilters, filterCount, priorityFilter, setPriorityFilter, priorityOptions, projectFilter, setProjectFilter, projectIds, projectNames, statusFilter, setStatusFilter, highOnly, setHighOnly, overdueOnly, setOverdueOnly, clearFilters, createTask, quickKeys, quickTitle, newDraft, pending, projects, patchQuick, tokenPatch, newDateValue, pickNewDate, writeAllowed, createUncertain, setCreateUncertain, createError, setCreateError, quickError, checkedUncertain, setCheckedUncertain, hiddenDrafts, editDrafts, setEditor, groups, groupTitle, groupSub, whenFor, openEditor, toggle, projectName, sortedTasks, emptyTitle, saveEditor, closeEditor, confirmDelete, setConfirmDelete, deleteEditor, draftStatus, compareLatest, upsert } = useTasks(apiStatus)
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
          {VIEWS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" aria-label={label} id={`tasks-tab-${id}`} aria-controls="tasks-panel" aria-selected={view === id} tabIndex={view === id || ((view === 'all' || view === 'matrix') && id === 'today') ? 0 : -1} onClick={() => setView(id)}><Icon size={16} /><span>{label}</span><b aria-hidden="true">{tasks.filter(task => inView(task, id)).length}</b></button>)}
        </div>
        <span className="tasks-spacer" />
        <label className="tasks-search"><Search size={16} /><input aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="tasks-more" ref={moreRef}>
          <button type="button" className="tasks-filter-button" aria-label="Filters and views" aria-haspopup="true" aria-expanded={moreOpen} data-active={activeFilters ? 'true' : undefined} onClick={() => setMoreOpen(value => !value)}><ListFilter size={16} />Filter{filterCount > 0 && <b>{filterCount}</b>}</button>
          {moreOpen && <div className="tasks-more-panel">
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
        <input ref={quickTitle} aria-label="Add a task" aria-describedby="tasks-quick-hint" placeholder="Add a task — Enter to save, Q to focus" value={newDraft.title} disabled={pending} onChange={event => { const parsed = parseQuickTokens(event.target.value, projects, new Date(), false); patchQuick(tokenPatch(parsed, newDraft)) }} />
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
