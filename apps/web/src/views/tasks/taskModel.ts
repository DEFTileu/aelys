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

export function isTaskUrgent(task: TaskOut, now = Date.now()): boolean {
  if (!task.due_at) return false
  const due = Date.parse(task.due_at)
  return Number.isFinite(due) && due <= now + 48 * 60 * 60 * 1000
}

export function groupTasksInMatrix(tasks: readonly TaskOut[], now = Date.now()) {
  const groups = [
    { key: 'important-urgent', label: 'Important and urgent', tasks: [] as TaskOut[] },
    { key: 'important-not-urgent', label: 'Important, not urgent', tasks: [] as TaskOut[] },
    { key: 'not-important-urgent', label: 'Urgent, not important', tasks: [] as TaskOut[] },
    { key: 'not-important-not-urgent', label: 'Neither urgent nor important', tasks: [] as TaskOut[] },
  ]
  for (const task of tasks) {
    if (!isCompleted(task)) groups[(task.priority >= 2 ? 0 : 2) + (isTaskUrgent(task, now) ? 0 : 1)].tasks.push(task)
  }
  return groups
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

export interface QuickTokens { title: string; dueDate?: string; dueTime?: string; priority?: string; projectId?: string }
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const localKey = (date: Date) => `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** Pulls `@date` (today, tomorrow, a weekday or YYYY-MM-DD), `@HH:MM`, `!p1`..`!p3` and `#project` tokens out of quick-add text. Unmatched tokens stay in the title.
 *  Unless `final`, a token still being typed (no trailing whitespace) is left alone. p1 is the highest priority. */
export function parseQuickTokens(text: string, projects: readonly { id: string; name: string }[], now = new Date(), final = true): QuickTokens {
  const out: QuickTokens = { title: '' }
  const settled = final || /\s$/.test(text) ? text : text.slice(0, text.search(/\S+$/))
  const tail = text.slice(settled.length)
  const kept = settled.replace(/(^|\s)([@#!])(\S+)(?=\s|$)/g, (whole, lead: string, mark: string, word: string) => {
    const lower = word.toLocaleLowerCase()
    if (mark === '@') {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const day = lower.length >= 3 ? DAYS.findIndex(name => name.startsWith(lower)) : -1
      if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) out.dueDate = lower
      else if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(lower)) out.dueTime = lower.padStart(5, '0')
      else if (lower === 'today') out.dueDate = localKey(date)
      else if (lower === 'tomorrow') { date.setDate(date.getDate() + 1); out.dueDate = localKey(date) }
      else if (day >= 0) { date.setDate(date.getDate() + (day - date.getDay() + 6) % 7 + 1); out.dueDate = localKey(date) }
      else return whole
    } else if (mark === '!') {
      const level = /^p([1-3])$/.exec(lower)?.[1]
      if (!level) return whole
      out.priority = String(4 - Number(level))
    } else {
      const match = projects.find(project => project.name.toLocaleLowerCase().startsWith(lower))
      if (!match) return whole
      out.projectId = match.id
    }
    return lead
  })
  const title = (kept + tail).replace(/\s{2,}/g, ' ').replace(/^\s+/, '')
  out.title = final ? title.trimEnd() : title
  return out
}

export function taskMatchesQuery(task: TaskOut, query: string, projectName = ''): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return [task.title, task.description, projectName].some((value) => value.toLocaleLowerCase().includes(needle))
}

export const dayDiff = (key: string, today: string) => Math.round((Date.parse(`${key}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 864e5)
/** Today / Tomorrow / Yesterday, a weekday within the week, otherwise "Nov 2" (the design's date wording). */
export function fmtDay(key: string, today: string): string {
  const n = dayDiff(key, today)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n === -1) return 'Yesterday'
  const date = new Date(`${key}T00:00:00`)
  return n > 1 && n < 7 ? date.toLocaleDateString('en-US', { weekday: 'long' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
// Project chips and cards take a stable colour from the design palette, keyed by id.
const PROJECT_COLORS = ['#6A4CF2', '#2F6FE4', '#14966C', '#D97706', '#E2553F', '#D9367E', '#0F9488']
export const projectColor = (id: string) => PROJECT_COLORS[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PROJECT_COLORS.length]
