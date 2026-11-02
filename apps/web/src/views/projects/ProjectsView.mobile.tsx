import type { ReactNode } from 'react'
import type { TaskOut } from '@aelys/shared'
import { ApiStatusPill } from '../../components/ApiStatusPill'
import { Icon } from '../../components/Icon'
import { PageSkeleton } from '../../components/PageSkeleton'
import { StateCard } from '../../components/StateCard'
import { dateKey, fmtDay, isOverdue, projectColor } from '../tasks/taskModel'
import { Archive, ArrowLeft, Check, FileText, Plus, SquarePen, Trash2 } from '../../icons'
import type { ApiStatus } from '../../types'
import './projects-mobile.css'
import { isDone, useProjects } from './useProjects'

// Shared time label for a task row: "Today · 10:00", "Oct 29".
function taskWhen(task: TaskOut): string {
  const today = dateKey(new Date().toISOString())!
  const key = dateKey(task.due_at)
  const clock = task.due_at && !/^23:59/.test(new Date(task.due_at).toTimeString()) ? new Date(task.due_at).toTimeString().slice(0, 5) : ''
  return [key ? fmtDay(key, today) : '', clock].filter(Boolean).join(' · ')
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return <>
    <div className="projects-m-scrim" onClick={onClose} />
    <div className="projects-m-sheet" role="dialog" aria-label={label}>{children}</div>
  </>
}

// One screen at a time: the card list, or a project detail with Back.
export function ProjectsMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const { projects, query, setQuery, setSelectedId, tasks, filter, setFilter, status, formOpen, setFormOpen, name, setName, description, setDescription, message, editing, setEditing, busy, notes, taskTitle, setTaskTitle, taskUncertain, load, visible, selected, projectTasks, createProject, updateProject, deleteProject, createTask, toggleTask, openNote } = useProjects(apiStatus)

  if (status !== 'ready') return <div className="projects-m"><PageSkeleton kind="grid" label="projects" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} /></div>

  const countFor = (item: 'all' | 'active' | 'archived') => item === 'all' ? projects.length : projects.filter((project) => item === 'archived' ? project.status === 'archived' : project.status !== 'archived').length
  const createSheet = formOpen && !selected
  const editSheet = editing && !!selected

  return <div className="projects-m">
    {!selected ? <>
      <div className="projects-m-head"><h1>Projects</h1><ApiStatusPill status={apiStatus} /></div>
      <div className="projects-m-filters" role="group" aria-label="Filter projects">{(['active', 'archived', 'all'] as const).map((item) => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>{item[0].toUpperCase() + item.slice(1)} <span>{countFor(item)}</span></button>)}</div>
      <label className="projects-m-search"><Icon name="search" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" /></label>
      {message && <p className="projects-m-message" role="status">{message}</p>}
      {visible.length === 0 ? <StateCard status="empty" title={query ? 'No matching projects' : 'No projects here'} description={query ? 'Try a different search term.' : 'Create a project or choose another filter.'} /> : <div className="projects-m-list" aria-label="Projects">
        {visible.map((project) => {
          const color = projectColor(project.id)
          const ratio = project.taskCount === 0 ? 0 : Math.round((project.completedCount / project.taskCount) * 100)
          const next = tasks?.find((task) => task.project_id === project.id && !isDone(task))
          return <button type="button" key={project.id} className="projects-m-card" onClick={() => setSelectedId(project.id)}>
            <span className="projects-m-card-top">
              <span className="projects-m-icon" style={{ color, background: `${color}1A` }}><Icon name="folder" size={22} /></span>
              <span className="projects-m-card-name"><strong>{project.name}</strong><small>{tasks === null ? 'Task counts unavailable' : `${project.taskCount - project.completedCount} open · ${project.completedCount} done`}{project.status === 'archived' ? ' · Archived' : ''}</small></span>
              <b>{tasks === null || !project.taskCount ? '—' : `${ratio}%`}</b>
            </span>
            <span className="projects-m-progress"><span style={{ width: `${ratio}%`, background: color }} /></span>
            <span className="projects-m-next">Next: <b>{tasks === null ? 'Tasks unavailable' : next?.title ?? 'Nothing planned'}</b></span>
          </button>
        })}
      </div>}
      <button className="projects-m-fab" type="button" aria-label="New project" onClick={() => setFormOpen(true)}><Plus size={24} /></button>
      {createSheet && <Sheet label="New project" onClose={() => setFormOpen(false)}>
        <form className="projects-m-form" onSubmit={createProject}>
          <h2>New project</h2>
          <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" aria-label="New project name" /></label>
          <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this project about?" aria-label="New project description" /></label>
          <div className="projects-m-sheet-actions"><button type="button" onClick={() => setFormOpen(false)}>Cancel</button><button className="projects-m-primary" type="submit">Save</button></div>
        </form>
      </Sheet>}
    </> : <section className="projects-m-detail">
      <button className="projects-m-back" type="button" onClick={() => setSelectedId(null)}><ArrowLeft size={18} />Projects</button>
      {message && <p className="projects-m-message" role="status">{message} {taskUncertain && <button type="button" onClick={() => void load()}>Reload tasks</button>}</p>}
      <div className="projects-m-panel">
        <div className="projects-m-detail-head"><span className="projects-m-icon projects-m-icon--lg" style={{ color: projectColor(selected.id), background: `${projectColor(selected.id)}1A` }}><Icon name="folder" size={26} /></span><div><h2>{selected.name}</h2><span className="projects-m-status" data-status={selected.status}>{selected.status}</span></div></div>
        <p className="projects-m-desc">{selected.description || 'No description yet.'}</p>
        <div className="projects-m-progress-row"><span>{tasks === null ? 'Task counts unavailable' : `${selected.taskCount - selected.completedCount} open · ${selected.completedCount} done`}</span><b>{tasks === null || !selected.taskCount ? '—' : `${Math.round(selected.completedCount / selected.taskCount * 100)}%`}</b></div>
        <div className="projects-m-progress"><span style={{ width: `${selected.taskCount ? selected.completedCount / selected.taskCount * 100 : 0}%`, background: projectColor(selected.id) }} /></div>
        <div className="projects-m-actions">
          <button type="button" onClick={() => { setName(selected.name); setDescription(selected.description); setEditing(true) }}><SquarePen size={16} />Edit</button>
          <button type="button" disabled={busy} onClick={() => void updateProject({ status: selected.status === 'archived' ? 'active' : 'archived' })}><Archive size={16} />{selected.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
          <button type="button" disabled={busy} onClick={() => void deleteProject()}><Trash2 size={16} />Delete</button>
        </div>
      </div>
      <section className="projects-m-panel"><h3>Overview</h3>{tasks === null ? <p>Progress unavailable</p> : <div className="projects-m-counts"><span><b>{selected.taskCount - selected.completedCount}</b>Open</span><span><b>{selected.completedCount}</b>Done</span><span><b>{projectTasks.filter((task) => isOverdue(task)).length}</b>Overdue</span><span><b>{selected.taskCount}</b>Total</span></div>}</section>
      <section className="projects-m-panel"><h3>Tasks <small>{tasks ? projectTasks.length : ''}</small></h3>
        <form className="projects-m-add" onSubmit={createTask}><Plus size={18} /><input aria-label="Add a task to this project" placeholder="Add a task to this project" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} disabled={busy || taskUncertain || apiStatus !== 'ready'} /><button type="submit" disabled={busy || taskUncertain || !taskTitle.trim() || apiStatus !== 'ready'}>Add</button></form>
        {tasks === null ? <p>Tasks are unavailable. Try again to load project progress.</p> : projectTasks.length ? [...projectTasks].sort((x, y) => Number(isDone(x)) - Number(isDone(y)) || (x.due_at ?? '9').localeCompare(y.due_at ?? '9')).map((task) => <div className={`projects-m-task${isDone(task) ? ' projects-m-task--done' : ''}`} key={task.id}>
          <button type="button" className="projects-m-check" role="checkbox" aria-checked={isDone(task)} aria-label={`Toggle ${task.title}`} disabled={busy || apiStatus !== 'ready'} onClick={() => void toggleTask(task)}>{isDone(task) && <Check size={14} />}</button>
          <button type="button" className="projects-m-task-title" onClick={() => { window.history.pushState({}, '', `/tasks?task=${encodeURIComponent(task.id)}`); window.dispatchEvent(new PopStateEvent('popstate')) }}><span>{task.title}</span>{taskWhen(task) && <small>{taskWhen(task)}</small>}</button>
        </div>) : <p>No tasks yet — progress appears once you add some.</p>}
      </section>
      <section className="projects-m-panel"><h3>Linked notes</h3>{notes === null ? <p>Notes unavailable.</p> : notes.filter((note) => note.project_id === selected.id).length ? notes.filter((note) => note.project_id === selected.id).map((note) => <button type="button" key={note.id} className="projects-m-note" onClick={() => openNote(note.id)}><FileText size={16} /><span><strong>{note.title}</strong><small>{(note.markdown_body || 'Empty note').replace(/\s+/g, ' ')}</small></span></button>) : <p>No notes linked to this project.</p>}</section>
      {editSheet && <Sheet label="Edit project" onClose={() => setEditing(false)}>
        <form className="projects-m-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void updateProject({ name: name.trim(), description: description.trim() }) }}>
          <h2>Edit project</h2>
          <label>Name<input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Description<textarea aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <div className="projects-m-sheet-actions"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button className="projects-m-primary" type="submit" disabled={busy || !name.trim()}>Save</button></div>
        </form>
      </Sheet>}
    </section>}
  </div>
}
