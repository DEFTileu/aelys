import { Check, Trash2, X } from '../../icons'
import { TaskEditor } from './TaskEditor'
import { draftFromTask } from './taskModel'
import { PRIORITIES, type useTasks } from './useTasks'

export type TasksState = ReturnType<typeof useTasks>

// The editor is shared by desktop and mobile; only the outer placement differs (CSS).
export function TaskEditorPanel(t: TasksState) {
  const { editor, setEditor, projects, projectsUnavailable, pending, writeAllowed, closeEditor, saveEditor, editDrafts, confirmDelete, setConfirmDelete, deleteEditor, compareLatest, upsert, projectName } = t
  if (!editor) return null
  return <TaskEditor value={editor.draft} onChange={draft => setEditor({ ...editor, draft })} task={editor.task} projects={projects} projectsUnavailable={projectsUnavailable} pending={pending} saveDisabled={!writeAllowed || editor.conflict} error={editor.error} onSave={() => void saveEditor()} onClose={closeEditor} dirty={JSON.stringify(editor.draft) !== JSON.stringify(draftFromTask(editor.task))} onRevert={() => { editDrafts.current.delete(editor.task.id); setEditor({ ...editor, draft: draftFromTask(editor.task), error: editor.conflict ? editor.error : '' }); setConfirmDelete(false) }} confirmDelete={confirmDelete} onDelete={() => { if (confirmDelete) void deleteEditor(); else setConfirmDelete(true) }} onCancelDelete={() => setConfirmDelete(false)} deleteDisabled={!writeAllowed || editor.conflict} notice={<>
      {!writeAllowed && <p className="tasks-source">Saving requires a connection. You can keep editing this draft.</p>}
      <p className="task-editor__sr">Closing keeps your draft here until you leave Tasks. {editor.task.rrule ? 'Existing recurrence is preserved.' : ''}</p>
      {editor.conflict && <div className="tasks-conflict"><p>This task changed elsewhere. Compare before replacing its fields.</p><button type="button" disabled={pending || !writeAllowed} onClick={() => void compareLatest()}>Compare latest</button>{editor.latest && <><h3>Latest saved version</h3><dl><dt>Title</dt><dd>{editor.latest.title}</dd><dt>Description</dt><dd>{editor.latest.description || 'None'}</dd><dt>Date</dt><dd>{editor.latest.due_at ? new Date(editor.latest.due_at).toLocaleString() : 'No date'}</dd><dt>Priority</dt><dd>{PRIORITIES[editor.latest.priority] ?? editor.latest.priority}</dd><dt>Project</dt><dd>{projectName(editor.latest) || 'None'}</dd><dt>Status</dt><dd>{editor.latest.status}</dd></dl><p>Keep my draft replaces these fields when you save. Parent and recurrence keep the latest saved values.</p><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ ...editor, fieldBase: editor.fieldBase ?? editor.task, task: latest, conflict: false, latest: null, error: '' }) }}>Keep my draft</button><button type="button" disabled={pending} onClick={() => { const latest = editor.latest!; upsert(latest); setEditor({ task: latest, draft: draftFromTask(latest), conflict: false, latest: null, error: '' }) }}>Use latest version</button></>}</div>}
    </>} />
}
