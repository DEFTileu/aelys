import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError, NetworkError, type ProjectResponse, type TaskOut } from '@aelys/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksView } from '../views/TasksView'

const client = vi.hoisted(() => ({ tasks: vi.fn(), projects: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), task: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const project: ProjectResponse = { id: 'project-1', name: 'Orion', description: '', status: 'active', version: 1 }
function task(overrides: Partial<TaskOut> = {}): TaskOut {
  return { id: 'task-1', version: 4, title: 'Plan launch', description: 'Review the checklist', project_id: 'project-1', parent_task_id: 'parent-1', status: 'todo', priority: 2, due_at: null, due_timezone: null, rrule: 'FREQ=WEEKLY', ...overrides }
}

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
async function mount(status: 'ready' | 'offline' = 'ready', defaultView = false) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<TasksView apiStatus={status} />))
  if (!defaultView) await act(async () => host.querySelector<HTMLButtonElement>('[role=tab][aria-label=Inbox]')!.click())
}
function button(name: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name)
  if (!match) throw new Error(`Button not found: ${name}`)
  return match
}
function field(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const direct = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')].find((item) => item.getAttribute('aria-label') === name)
  const labels = [...host.querySelectorAll('label')].filter((item) => [...item.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === name))
  const label = labels.find((item) => item.closest('[role="dialog"]')) ?? labels[0]
  const result = direct ?? label?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')
  if (!result) throw new Error(`Field not found: ${name}`)
  return result
}
async function click(name: string) { await act(async () => { if (name === 'New task') field('Add a task').focus(); else button(name).click() }) }
async function setField(name: string, value: string) {
  const element = field(name)
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function submit(name: string) {
  const form = button(name).closest('form')
  if (!form) throw new Error(`Form not found: ${name}`)
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function key(target: EventTarget, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}
function row(title: string) { return host.querySelector(`[aria-label="Open task: ${title}"]`) }
function dialog() { return host.querySelector('[role="dialog"][aria-label="Task details"], [role="dialog"][aria-labelledby]') }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  client.tasks.mockResolvedValue([])
  client.projects.mockResolvedValue([project])
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('Tasks workspace', () => {
  it('defaults to Today and separates active tasks from Completed', async () => {
    const now = new Date(); now.setHours(12, 0, 0, 0)
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
    client.tasks.mockResolvedValue([task({ id: 'past', title: 'Past', due_at: yesterday.toISOString() }), task({ id: 'today', title: 'Due today', due_at: now.toISOString() }), task({ id: 'done', title: 'Done', due_at: now.toISOString(), status: 'completed' }), task({ id: 'inbox', title: 'Undated' })])
    await mount('ready', true)
    expect(button('Today').getAttribute('aria-selected')).toBe('true')
    expect(row('Past')).not.toBeNull(); expect(row('Due today')).not.toBeNull(); expect(row('Done')).toBeNull(); expect(row('Undated')).toBeNull()
    expect(host.querySelector('[aria-label="Overdue"]')).not.toBeNull()
    expect(host.querySelector('.tasks-filter-disclosure')).toBeNull()
    expect(host.querySelector('[aria-label="New task"]')).toBeNull()
    await click('Completed'); expect(row('Done')).not.toBeNull(); expect(row('Due today')).toBeNull()
    await click('Inbox'); expect(row('Undated')).not.toBeNull(); expect(row('Done')).toBeNull()
    await click('All tasks'); expect(row('Done')).not.toBeNull(); expect(row('Past')).not.toBeNull()
  })

  it('creates an undated task in the default Inbox without an offline queue', async () => {
    const created = task({ title: 'Buy paper', project_id: null, parent_task_id: null, description: '', priority: 0, rrule: null, version: 1 })
    client.createTask.mockImplementation(async () => { client.tasks.mockResolvedValue([created]); return created })
    await mount()
    await click('New task')
    await setField('New task title', 'Buy paper')
    await submit('Add task')
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buy paper', due_at: null }), expect.objectContaining({ queueOnOffline: false }))
    expect(row('Buy paper')).not.toBeNull()
  })

  it('sends optional quick-add fields as a local timezone-aware instant', async () => {
    client.createTask.mockResolvedValue(task())
    await mount()
    await click('New task')
    await setField('New task title', 'Timed task')
    await click('Add details')
    await setField('New due date', '2026-11-17')
    await setField('New due time', '14:35')
    await setField('Quick priority', '3')
    await setField('Quick project', project.id)
    await submit('Add task')
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Timed task', due_at: new Date(2026, 10, 17, 14, 35).toISOString(), due_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, priority: 3, project_id: project.id }), expect.objectContaining({ queueOnOffline: false }))
  })

  it.each(['Open task: Plan launch', 'Change priority: Plan launch', 'Task details: Plan launch'])('opens the editor from %s', async (trigger) => {
    client.tasks.mockResolvedValue([task()])
    await mount()
    await click(trigger)
    const editor = dialog()
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toMatch(/task details/i)
    expect(field('Task title').value).toBe('Plan launch')
    expect(field('Description').value).toBe('Review the checklist')
    await click('Close task editor')
    expect(dialog()).toBeNull()
  })

  it('saves full edits with the original parent, recurrence and version', async () => {
    const original = task()
    client.tasks.mockResolvedValue([original])
    client.updateTask.mockResolvedValue({ ...original, title: 'Launch ready', description: 'Updated notes', version: 5 })
    await mount()
    await click('Open task: Plan launch')
    await setField('Task title', 'Launch ready')
    await setField('Description', 'Updated notes')
    await setField('Due date', '2026-11-17')
    await setField('Due time', '14:35')
    await click('High')
    await setField('Project', project.id)
    await setField('Status', 'in_progress')
    await submit('Save changes')
    expect(client.updateTask).toHaveBeenCalledWith(original.id, expect.objectContaining({ title: 'Launch ready', description: 'Updated notes', due_at: new Date(2026, 10, 17, 14, 35).toISOString(), priority: 3, project_id: project.id, status: 'in_progress', parent_task_id: original.parent_task_id, rrule: original.rrule, version: 4 }), expect.objectContaining({ queueOnOffline: false }))
  })

  it('reverts unsaved edits and confirms deletion against a fresh version', async () => {
    const original = task(); client.tasks.mockResolvedValue([original]); client.task.mockResolvedValue(original); client.deleteTask.mockResolvedValue({ deleted: true })
    await mount(); await click('Open task: Plan launch'); await setField('Task title', 'Edited')
    expect(host.textContent).toContain('Unsaved')
    await click('Revert'); expect(field('Task title').value).toBe(original.title)
    await click('Delete'); expect(client.deleteTask).not.toHaveBeenCalled()
    await click('Cancel'); expect(client.deleteTask).not.toHaveBeenCalled()
    await click('Delete'); await click('Confirm delete')
    expect(client.task).toHaveBeenCalledWith(original.id, { allowCacheFallback: false })
    expect(client.deleteTask).toHaveBeenCalledWith(original.id, { version: original.version }, { queueOnOffline: false })
    expect(row(original.title)).toBeNull()
  })

  it('keeps the editor and draft when deletion encounters a newer task', async () => {
    const original = task(); client.tasks.mockResolvedValue([original]); client.task.mockResolvedValue({ ...original, version: 5 })
    await mount(); await click('Open task: Plan launch'); await setField('Task title', 'My draft')
    await click('Delete'); await click('Confirm delete')
    expect(client.deleteTask).not.toHaveBeenCalled(); expect(field('Task title').value).toBe('My draft')
    expect(host.textContent).toMatch(/version conflict/i)
  })

  it('creates with inline date, priority and project options', async () => {
    client.createTask.mockResolvedValue(task())
    await mount(); await click('New task'); await setField('New task title', 'Inline')
    await setField('Quick date', 'tomorrow'); await setField('Quick priority', '3'); await setField('Quick project', project.id)
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(23, 59, 0, 0)
    await submit('Add task')
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Inline', due_at: tomorrow.toISOString(), priority: 3, project_id: project.id }), expect.anything())
  })

  it('completes a task without dropping any fields and sends its version', async () => {
    const original = task({ due_at: '2026-11-17T10:00:00.000Z', due_timezone: 'Asia/Almaty' })
    client.tasks.mockResolvedValue([original])
    client.updateTask.mockResolvedValue({ ...original, status: 'completed', version: 5 })
    await mount()
    await click('All tasks')
    await click('Complete Plan launch')
    const { id, ...fields } = original
    expect(client.updateTask).toHaveBeenCalledWith(id, expect.objectContaining({ ...fields, status: 'completed' }), expect.objectContaining({ queueOnOffline: false }))
  })

  it('searches descriptions and project names and combines project, status and priority filters', async () => {
    client.tasks.mockResolvedValue([
      task({ title: 'Alpha', description: 'Secret checklist', priority: 3 }),
      task({ id: '2', title: 'Beta', description: '', status: 'completed', priority: 3 }),
      task({ id: '3', title: 'Gamma', description: '', project_id: null, priority: 1 }),
    ])
    await mount()
    await click('All tasks')
    await setField('Search tasks', 'checklist')
    expect(row('Alpha')).not.toBeNull()
    expect(row('Beta')).toBeNull()
    await setField('Search tasks', 'orion')
    expect(row('Alpha')).not.toBeNull()
    expect(row('Beta')).not.toBeNull()
    expect(row('Gamma')).toBeNull()
    await setField('Search tasks', '')
    await setField('Filter by project', project.id)
    await setField('Filter by status', 'active')
    await click('High priority')
    expect(button('High priority').getAttribute('aria-pressed')).toBe('true')
    expect(row('Alpha')).not.toBeNull()
    expect(row('Beta')).toBeNull()
    expect(row('Gamma')).toBeNull()
    await setField('Filter by status', 'completed')
    expect(row('Alpha')).toBeNull()
    expect(row('Beta')).not.toBeNull()
  })

  it('supports Q outside inputs, Enter to add and Escape without losing a draft', async () => {
    client.createTask.mockResolvedValue(task({ title: 'Draft from keyboard' }))
    await mount()
    const search = field('Search tasks')
    search.focus()
    await key(search, 'q')
    expect(host.querySelector('[aria-label="New task title"]')).toBeNull()
    await key(document.body, 'q')
    await setField('New task title', 'Draft from keyboard')
    await key(field('New task title'), 'Escape')
    expect(host.querySelector('[aria-label="New task title"]')).toBeNull()
    await key(document.body, 'q')
    expect(field('New task title').value).toBe('Draft from keyboard')
    const title = field('New task title')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      title.dispatchEvent(enter)
      // jsdom does not perform the browser's implicit form submission.
      if (!enter.defaultPrevented && !client.createTask.mock.calls.length) title.closest('form')?.requestSubmit()
    })
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft from keyboard' }), expect.objectContaining({ queueOnOffline: false }))
  })

  it('keeps a conflicting draft until the user compares and explicitly rebases it', async () => {
    const original = task()
    const latest = task({ title: 'Server title', description: 'Server notes', version: 7 })
    client.tasks.mockResolvedValue([original])
    client.task.mockResolvedValue(latest)
    client.updateTask.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', 'Version conflict')).mockResolvedValueOnce({ ...latest, title: 'My draft', version: 8 })
    await mount()
    await click('Open task: Plan launch')
    await setField('Task title', 'My draft')
    await submit('Save changes')
    expect(field('Task title').value).toBe('My draft')
    expect(dialog()).not.toBeNull()
    expect(host.textContent).toMatch(/conflict/i)
    expect(host.textContent).not.toMatch(/task saved|changes saved/i)
    await click('Compare latest')
    expect(client.task).toHaveBeenCalledWith(original.id)
    expect(host.textContent).toContain('Server title')
    expect(field('Task title').value).toBe('My draft')
    await click('Keep my draft')
    await submit('Save changes')
    expect(client.updateTask).toHaveBeenLastCalledWith(original.id, expect.objectContaining({ title: 'My draft', version: 7 }), expect.objectContaining({ queueOnOffline: false }))
  })

  it('keeps a parked draft and its original precise due instant through a stale toggle conflict', async () => {
    const original = task({ due_at: '2026-11-17T10:15:12.345Z', due_timezone: 'Asia/Tokyo' })
    const latest = task({ due_at: '2026-11-17T10:15:47.789Z', due_timezone: 'Europe/Paris', version: 7, parent_task_id: 'latest-parent', rrule: 'FREQ=DAILY' })
    client.tasks.mockResolvedValue([original])
    client.task.mockResolvedValue(latest)
    client.updateTask.mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', 'Version conflict'))
      .mockResolvedValueOnce({ ...latest, description: 'Parked description', due_at: original.due_at, due_timezone: original.due_timezone, version: 8 })
    await mount()
    await click('All tasks')
    await click('Open task: Plan launch')
    await setField('Description', 'Parked description')
    await click('Close task editor')
    await click('Complete Plan launch')
    expect(dialog()).not.toBeNull()
    expect(field('Description').value).toBe('Parked description')
    expect(host.textContent).toMatch(/conflict/i)
    await click('Compare latest')
    expect(client.task).toHaveBeenCalledWith(original.id)
    expect(field('Description').value).toBe('Parked description')
    await click('Keep my draft')
    await submit('Save changes')
    expect(client.updateTask).toHaveBeenLastCalledWith(original.id, expect.objectContaining({
      description: 'Parked description', due_at: original.due_at, due_timezone: original.due_timezone,
      parent_task_id: latest.parent_task_id, rrule: latest.rrule, version: latest.version,
    }), expect.objectContaining({ queueOnOffline: false }))
  })

  it('retains create and editor drafts when network writes fail', async () => {
    client.tasks.mockResolvedValue([task()])
    client.createTask.mockRejectedValue(new NetworkError('Network unavailable'))
    client.updateTask.mockRejectedValue(new Error('Network unavailable'))
    await mount()
    await click('New task')
    await setField('New task title', 'Unsent task')
    await submit('Add task')
    expect(field('New task title').value).toBe('Unsent task')
    expect(host.textContent).toMatch(/network|connection|offline/i)
    expect(host.textContent).not.toMatch(/task saved|task created/i)
    await click('Close quick add')
    await click('Open task: Plan launch')
    await setField('Description', 'Unsent edit')
    await submit('Save changes')
    expect(field('Description').value).toBe('Unsent edit')
    expect(dialog()).not.toBeNull()
    expect(host.textContent).toMatch(/network|connection|offline/i)
  })

  it.each([new NetworkError('Connection lost'), new ApiError(503, 'UNAVAILABLE', 'Server unavailable')])('uses cached reads as read-only after a live read fails: %s', async (failure) => {
    client.tasks.mockImplementation(async (_query: unknown, options?: { allowCacheFallback?: boolean }) => {
      if (options?.allowCacheFallback === false) throw failure
      return [task()]
    })
    await mount()
    expect(client.tasks.mock.calls.some((args) => args[1]?.allowCacheFallback === false)).toBe(true)
    expect(client.tasks.mock.calls.some((args) => args.length === 0)).toBe(true)
    expect(row('Plan launch')).not.toBeNull()
    expect(host.textContent).toMatch(/cached|cache/i)
    expect(button('Complete Plan launch').disabled).toBe(true)
    await click('Open task: Plan launch')
    expect(button('Save changes').disabled).toBe(true)
    expect(client.updateTask).not.toHaveBeenCalled()
  })

  it('does not fall back to cached tasks for a rejected authorization read', async () => {
    client.tasks.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    await mount()
    expect(client.tasks.mock.calls.some((args) => args[1]?.allowCacheFallback === false)).toBe(true)
    expect(client.tasks.mock.calls.some((args) => args.length === 0)).toBe(false)
    expect(row('Plan launch')).toBeNull()
  })

  it('requires checking the list and explicit permission before retrying an ambiguous create', async () => {
    client.createTask.mockRejectedValueOnce(new NetworkError('Connection lost'))
      .mockResolvedValueOnce(task({ title: 'Possibly created' }))
    await mount()
    await click('New task')
    await setField('New task title', 'Possibly created')
    await submit('Add task')
    expect(field('New task title').value).toBe('Possibly created')
    expect(button('Add task').disabled).toBe(true)
    expect(client.createTask).toHaveBeenCalledTimes(1)
    expect(host.textContent).toMatch(/unconfirmed|unknown|could not confirm|may have|no save confirmation/i)
    await click('Check task list')
    expect(client.tasks.mock.calls.some((args) => args[1]?.allowCacheFallback === false)).toBe(true)
    expect(button('Add task').disabled).toBe(true)
    expect(client.createTask).toHaveBeenCalledTimes(1)
    await click('Allow another attempt')
    expect(field('New task title').value).toBe('Possibly created')
    await submit('Add task')
    expect(client.createTask).toHaveBeenCalledTimes(2)
  })

  it('allows correcting and retrying a definite validation failure', async () => {
    client.createTask.mockRejectedValueOnce(new ApiError(422, 'VALIDATION_ERROR', 'Invalid task'))
      .mockResolvedValueOnce(task({ title: 'Corrected' }))
    await mount()
    await click('New task')
    await setField('New task title', 'Original')
    await submit('Add task')
    expect(field('New task title').value).toBe('Original')
    expect(button('Add task').disabled).toBe(false)
    await setField('New task title', 'Corrected')
    await submit('Add task')
    expect(client.createTask).toHaveBeenCalledTimes(2)
  })

  it('identifies an initial cached fallback as unconfirmed and prevents updates', async () => {
    const cached = task()
    client.tasks.mockImplementation(async (_query: unknown, options?: { allowCacheFallback?: boolean }) => {
      if (options?.allowCacheFallback === false) throw new NetworkError('Connection lost')
      return [cached]
    })
    await mount()
    expect(row(cached.title)).not.toBeNull()
    expect(host.textContent).toMatch(/cached|cache/i)
    expect(host.textContent).not.toMatch(/changes saved|task updated|task saved/i)
    expect(button('Complete Plan launch').disabled).toBe(true)
    await click('Open task: Plan launch')
    expect(button('Save changes').disabled).toBe(true)
    expect(client.updateTask).not.toHaveBeenCalled()
  })

  it('shows cached tasks offline while disabling writes and explaining the limitation', async () => {
    client.tasks.mockResolvedValue([task()])
    await mount('offline')
    expect(row('Plan launch')).not.toBeNull()
    expect(host.textContent).toMatch(/offline|connection/i)
    expect(host.textContent).toMatch(/cached|cache/i)
    const complete = button('Complete Plan launch')
    expect(complete.disabled).toBe(true)
    await click('Open task: Plan launch')
    expect(button('Save changes').disabled).toBe(true)
    expect(client.createTask).not.toHaveBeenCalled()
    expect(client.updateTask).not.toHaveBeenCalled()
  })
  it('separates undated, today and upcoming using local day boundaries', async () => {
    const today = new Date(); today.setHours(0, 15, 0, 0)
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
    client.tasks.mockResolvedValue([
      task({ id: 'undated', title: 'Undated', due_at: null }),
      task({ id: 'today', title: 'Local today', due_at: today.toISOString() }),
      task({ id: 'future', title: 'Local tomorrow', due_at: tomorrow.toISOString() }),
      task({ id: 'past', title: 'Local yesterday', due_at: yesterday.toISOString() }),
    ])
    await mount()
    expect(row('Undated')).not.toBeNull()
    expect(row('Local today')).toBeNull()
    await click('Today')
    expect(row('Local today')).not.toBeNull()
    expect(row('Local tomorrow')).toBeNull()
    expect(row('Local yesterday')).not.toBeNull()
    await click('Upcoming')
    expect(row('Local tomorrow')).not.toBeNull()
    expect(row('Local today')).toBeNull()
    expect(row('Undated')).toBeNull()
    await click('All tasks')
    for (const title of ['Undated', 'Local today', 'Local tomorrow', 'Local yesterday']) expect(row(title)).not.toBeNull()
  })

  it('honors a late authorization rejection even after a write invalidates an in-flight refresh', async () => {
    const original = task()
    client.tasks.mockResolvedValue([original])
    let resolveWrite!: (value: TaskOut) => void
    let rejectRead!: (error: Error) => void
    client.updateTask.mockImplementation(() => new Promise<TaskOut>(resolve => { resolveWrite = resolve }))
    await mount()
    await click('Complete Plan launch')
    client.tasks.mockImplementation(() => new Promise<readonly TaskOut[]>((_resolve, reject) => { rejectRead = reject }))
    await act(async () => window.dispatchEvent(new Event('online')))
    await act(async () => resolveWrite({ ...original, status: 'completed', version: 5 }))
    await act(async () => rejectRead(new ApiError(403, 'FORBIDDEN', 'Owner session rejected')))
    expect(row('Plan launch')).toBeNull()
    expect(host.textContent).toMatch(/session ended/i)
    await click('New task')
    await setField('New task title', 'Private draft')
    expect(button('Add task').disabled).toBe(true)
  })

  it('keeps pending and error focus inside the editor and ignores composition Escape', async () => {
    client.tasks.mockResolvedValue([task()])
    let rejectWrite!: (error: Error) => void
    client.updateTask.mockImplementation(() => new Promise<TaskOut>((_resolve, reject) => { rejectWrite = reject }))
    await mount()
    await click('Open task: Plan launch')
    await setField('Description', 'Keep this draft')
    await act(async () => field('Description').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
    expect(dialog()).not.toBeNull()
    await submit('Save changes')
    expect(document.activeElement).toBe(dialog())
    await act(async () => rejectWrite(new ApiError(422, 'VALIDATION_ERROR', 'Rejected')))
    expect(field('Description').value).toBe('Keep this draft')
    expect(document.activeElement?.getAttribute('role')).toBe('alert')
    expect(dialog()?.contains(document.activeElement)).toBe(true)
  })

})
