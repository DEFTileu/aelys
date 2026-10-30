import { StyledSelect } from '../../components/controls/StyledSelect'
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react'
import type { ProjectResponse, TaskOut } from '@aelys/shared'
import type { TaskDraft } from './taskModel'
import './task-editor.css'

export interface TaskEditorProps {
  value: TaskDraft
  onChange: (value: TaskDraft) => void
  task: TaskOut
  projects: readonly ProjectResponse[]
  projectsUnavailable: boolean
  pending: boolean
  saveDisabled?: boolean
  error: string
  notice?: ReactNode
  onSave: () => void
  onClose: () => void
  dirty: boolean
  onRevert: () => void
  confirmDelete: boolean
  onDelete: () => void
  onCancelDelete: () => void
  deleteDisabled: boolean
}

const focusableSelector = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function TaskEditor({ value, onChange, task, projects, projectsUnavailable, pending, saveDisabled = false, error, notice, onSave, onClose, dirty, onRevert, confirmDelete, onDelete, onCancelDelete, deleteDisabled }: TaskEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  const pendingRef = useRef(pending)
  const pendingFocus = useRef<HTMLElement | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const headingId = useId()
  const dateHelpId = useId()
  onCloseRef.current = onClose
  pendingRef.current = pending

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    titleRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        if (!pendingRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0)
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        event.preventDefault()
        dialog.focus()
      } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (opener?.isConnected && opener.matches(focusableSelector) && !opener.matches(':disabled')) opener.focus()
      else {
        const row = Array.from(document.querySelectorAll<HTMLElement>('[data-task-row]')).find(element => element.getAttribute('data-task-row') === task.id)
        ;(row?.querySelector<HTMLElement>('[data-task-editor-trigger]:not(:disabled)') ?? document.querySelector<HTMLElement>('.tasks-screen [data-task-editor-trigger]:not(:disabled)'))?.focus()
      }
    }
  }, [])

  useEffect(() => {
    if (pending) {
      pendingFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialogRef.current?.focus()
    } else if (pendingFocus.current) {
      if (pendingFocus.current.isConnected && !pendingFocus.current.matches(':disabled')) pendingFocus.current.focus()
      else titleRef.current?.focus()
      pendingFocus.current = null
    }
  }, [pending])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  const patch = (changes: Partial<TaskDraft>) => onChange({ ...value, ...changes })
  const knownPriority = ['0', '1', '2', '3'].includes(value.priority)
  const knownStatus = ['todo', 'in_progress', 'completed'].includes(value.status)
  const knownProject = !value.projectId || projects.some((project) => project.id === value.projectId)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!pending && !saveDisabled) onSave()
  }

  return <div className="task-editor__backdrop" onClick={(event) => {
    if (event.target === event.currentTarget && !pending) onClose()
  }}>
    <div ref={dialogRef} className="task-editor__dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} data-task-id={task.id} tabIndex={-1}>
      <form className="task-editor__form" onSubmit={submit}>
        <header className="task-editor__header">
          <h2 id={headingId}>Task details</h2>{dirty && <span className="task-editor__unsaved">Unsaved</span>}
          <button className="task-editor__close" type="button" aria-label="Close task editor" disabled={pending} onClick={onClose}>×</button>
        </header>
        <div className="task-editor__body">
          <button className="task-editor__complete" type="button" role="checkbox" aria-checked={value.status === 'completed'} disabled={pending} onClick={() => patch({ status: value.status === 'completed' ? 'todo' : 'completed' })}><span>{value.status === 'completed' ? '✓' : ''}</span>Completed</button>
          {error && <p ref={errorRef} tabIndex={-1} className="task-editor__error" role="alert">{error}</p>}
          <label className="task-editor__field">Task title
            <input ref={titleRef} aria-label="Task title" type="text" value={value.title} required disabled={pending} onChange={(event) => patch({ title: event.target.value })} />
          </label>
          <label className="task-editor__field">Description
            <textarea aria-label="Description" rows={4} value={value.description} disabled={pending} onChange={(event) => patch({ description: event.target.value })} />
          </label>
          <div className="task-editor__date-fields">
            <label className="task-editor__field">Due date
              <input aria-label="Due date" type="date" value={value.dueDate} disabled={pending} aria-describedby={dateHelpId} onChange={(event) => patch({ dueDate: event.target.value, ...(event.target.value ? {} : { dueTime: '' }) })} />
            </label>
            <label className="task-editor__field">Due time
              <input aria-label="Due time" type="time" value={value.dueTime} disabled={pending || !value.dueDate} aria-describedby={dateHelpId} onChange={(event) => patch({ dueTime: event.target.value })} />
            </label>
          </div>
          <p id={dateHelpId} className="task-editor__help">Times shown in {timeZone}. If no time is selected, the due time defaults to 23:59.</p>
          <div className="task-editor__field">Priority
            <div className="task-editor__priorities" role="radiogroup" aria-label="Priority">{[['0','None'],['3','High'],['2','Medium'],['1','Low']].map(([priority, label]) => <button type="button" role="radio" aria-checked={value.priority === priority} key={priority} disabled={pending} onClick={() => patch({ priority })}>{label}</button>)}{!knownPriority && <span>Current priority ({value.priority})</span>}</div>
          </div>
          <div className="task-editor__field">Project
            <StyledSelect aria-label="Project" value={value.projectId} disabled={pending || projectsUnavailable} onChange={(event) => patch({ projectId: event.target.value })}>
              <option value="">None</option>
              {!knownProject && <option value={value.projectId}>Current project ({value.projectId})</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </StyledSelect>
          </div>
          {projectsUnavailable && <p className="task-editor__help">Projects are unavailable. The current project will be preserved.</p>}
          {notice}
          <details className="task-editor__advanced"><summary>More options</summary><div className="task-editor__field">Status
            <StyledSelect aria-label="Status" value={value.status} disabled={pending} onChange={(event) => patch({ status: event.target.value })}>
              {!knownStatus && <option value={value.status}>Current status ({value.status})</option>}
              <option value="todo">To do</option><option value="in_progress">In progress</option><option value="completed">Completed</option>
            </StyledSelect>
          </div></details>
        </div>
        <footer className="task-editor__footer">
          {confirmDelete && <span className="task-editor__confirm" role="status">Delete this task?</span>}
          <button className="task-editor__delete" type="button" disabled={pending || deleteDisabled} onClick={onDelete}>{confirmDelete ? 'Confirm delete' : 'Delete'}</button>
          {confirmDelete && <button className="task-editor__secondary" type="button" disabled={pending} onClick={onCancelDelete}>Cancel</button>}
          {dirty && <button className="task-editor__secondary" type="button" disabled={pending} onClick={onRevert}>Revert</button>}
          <button className="task-editor__save" type="submit" disabled={pending || saveDisabled}>{pending ? 'Saving' : 'Save changes'}</button>
        </footer>
      </form>
    </div>
  </div>
}
