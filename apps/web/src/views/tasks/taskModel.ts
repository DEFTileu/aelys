import type { TaskIn, TaskOut } from '@aelys/shared'

export interface TaskDraft {
  title: string
  description: string
  dueDate: string
  dueTime: string
  priority: string
  projectId: string
  status: string
}

export function emptyDraft(): TaskDraft {
  return { title: '', description: '', dueDate: '', dueTime: '', priority: '0', projectId: '', status: 'todo' }
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function dateKey(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return null
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function draftFromTask(task: TaskOut): TaskDraft {
  const date = task.due_at ? new Date(task.due_at) : null
  const validDate = date && Number.isFinite(date.getTime()) ? date : null
  return {
    title: task.title, description: task.description,
    dueDate: dateKey(task.due_at) ?? '',
    dueTime: validDate ? `${pad(validDate.getHours())}:${pad(validDate.getMinutes())}` : '',
    priority: String(task.priority), projectId: task.project_id ?? '', status: task.status,
  }
}

function localInstant(dateValue: string, timeValue: string): Date {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue)
  if (!dateParts) throw new Error('Due date must be a valid date in YYYY-MM-DD format')
  const timeParts = /^(\d{2}):(\d{2})$/.exec(timeValue)
  if (!timeParts) throw new Error('Due time must be in HH:mm format')
  const [, yearText, monthText, dayText] = dateParts
  const [, hourText, minuteText] = timeParts
  const year = Number(yearText), month = Number(monthText), day = Number(dayText)
  const hour = Number(hourText), minute = Number(minuteText)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error('Due date and time must be valid')
  }
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) {
    throw new Error('Due date or time is invalid or does not exist in your local timezone')
  }
  return date
}

export function draftToInput(draft: TaskDraft, original?: TaskOut): TaskIn {
  const title = draft.title.trim()
  if (!title) throw new Error('Title is required')
  const priority = Number(draft.priority)
  if (!(original && draft.priority === String(original.priority)) && !/^[0-3]$/.test(draft.priority)) {
    throw new Error('Priority must be a number from 0 to 3')
  }
  if (!draft.dueDate && draft.dueTime) throw new Error('Choose a due date before setting a due time')
  const instant = draft.dueDate ? localInstant(draft.dueDate, draft.dueTime || '23:59') : null
  const previous = original ? draftFromTask(original) : null
  const unchanged = previous && draft.dueDate === previous.dueDate && draft.dueTime === previous.dueTime
  return {
    title, description: draft.description, project_id: draft.projectId || null,
    parent_task_id: original?.parent_task_id ?? null, status: draft.status, priority,
    due_at: unchanged ? original!.due_at : instant?.toISOString() ?? null,
    due_timezone: unchanged ? original!.due_timezone : instant ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
    rrule: original?.rrule ?? null,
  }
}

export function fullTaskInput(task: TaskOut): TaskIn {
  return { title: task.title, description: task.description, project_id: task.project_id,
    parent_task_id: task.parent_task_id, status: task.status, priority: task.priority,
    due_at: task.due_at, due_timezone: task.due_timezone, rrule: task.rrule }
}

export function isCompleted(task: TaskOut): boolean {
  return ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())
}

export function isOverdue(task: TaskOut, now = Date.now()): boolean {
  if (isCompleted(task) || !task.due_at) return false
  const due = new Date(task.due_at).getTime()
  return Number.isFinite(due) && due < now
}

export function groupTasksByDay(tasks: readonly TaskOut[]): readonly { key: string; label: string; tasks: readonly TaskOut[] }[] {
  const groups = new Map<string, TaskOut[]>()
  for (const task of tasks) {
    const key = dateKey(task.due_at) ?? ''
    const group = groups.get(key) ?? []
    group.push(task)
    groups.set(key, group)
  }
  return [...groups.entries()].sort(([a], [b]) => a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)).map(([key, grouped]) => ({
    key, label: key ? new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(localInstant(key, '12:00')) : 'No date', tasks: grouped,
  }))
}

export function taskMatchesQuery(task: TaskOut, query: string, projectName = ''): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return [task.title, task.description, projectName].some((value) => value.toLocaleLowerCase().includes(needle))
}
