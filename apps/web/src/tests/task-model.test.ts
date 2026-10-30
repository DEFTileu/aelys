import { describe, expect, it } from 'vitest'
import type { TaskOut } from '@aelys/shared'
import { dateKey, draftFromTask, draftToInput, emptyDraft, fullTaskInput, groupTasksByDay, isCompleted, isOverdue, taskMatchesQuery } from '../views/tasks/taskModel'

function task(overrides: Partial<TaskOut> = {}): TaskOut {
  return { id: 'task-1', version: 4, title: 'Read', description: '  Notes  ', project_id: 'project-1', parent_task_id: 'parent-1', status: 'todo', priority: 2, due_at: '2025-06-01T12:34:56.123Z', due_timezone: 'Asia/Tokyo', rrule: 'FREQ=DAILY', ...overrides }
}

describe('task drafts', () => {
  it('creates fresh defaults and preserves all fields for an unchanged task', () => {
    expect(emptyDraft()).toEqual({ title: '', description: '', dueDate: '', dueTime: '', priority: '0', projectId: '', status: 'todo' })
    expect(emptyDraft()).not.toBe(emptyDraft())
    const original = task()
    expect(draftToInput(draftFromTask(original), original)).toEqual(fullTaskInput(original))
    expect(fullTaskInput(original)).not.toHaveProperty('version')
  })

  it('converts local dates to instants and defaults an omitted time to 23:59', () => {
    const input = draftToInput({ ...emptyDraft(), title: '  Finish  ', description: '  keep  ', dueDate: '2025-06-11', priority: '3' })
    expect(input.title).toBe('Finish')
    expect(input.description).toBe('  keep  ')
    expect(input.due_at).toBe(new Date(2025, 5, 11, 23, 59).toISOString())
    expect(input.due_timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(draftFromTask(task({ due_at: input.due_at ?? null })).dueDate).toBe('2025-06-11')
  })

  it('updates the instant and timezone when the local time changes', () => {
    const original = task()
    const input = draftToInput({ ...draftFromTask(original), dueDate: '2025-06-11', dueTime: '08:15' }, original)
    expect(input.due_at).toBe(new Date(2025, 5, 11, 8, 15).toISOString())
    expect(input.due_timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(input.rrule).toBe(original.rrule)
  })

  it('preserves legacy priority only when unchanged and clears date metadata', () => {
    const original = task({ priority: 7 })
    const draft = draftFromTask(original)
    expect(draftToInput({ ...draft, dueDate: '', dueTime: '' }, original)).toMatchObject({ priority: 7, due_at: null, due_timezone: null, parent_task_id: 'parent-1', rrule: 'FREQ=DAILY' })
    expect(() => draftToInput({ ...draft, priority: '8' }, original)).toThrow(/priority/i)
    expect(draftToInput({ ...draft, priority: '1' }, original).priority).toBe(1)
  })

  it.each([
    [{ title: ' ' }, /title/i],
    [{ priority: '' }, /priority/i],
    [{ priority: '1.0' }, /priority/i],
    [{ dueTime: '09:00' }, /date/i],
    [{ dueDate: '2025-02-29' }, /date/i],
    [{ dueDate: '2025-2-09' }, /date/i],
    [{ dueDate: '2025-01-01', dueTime: '24:00' }, /time/i],
    [{ dueDate: '2025-01-01', dueTime: '9:00' }, /time/i],
  ])('rejects invalid input %o', (changes, error) => {
    expect(() => draftToInput({ ...emptyDraft(), title: 'Task', ...changes })).toThrow(error)
  })

  it('rejects local times skipped by a daylight-saving transition', () => {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'America/New_York') return
    expect(() => draftToInput({ ...emptyDraft(), title: 'Task', dueDate: '2025-03-09', dueTime: '02:30' })).toThrow(/does not exist/i)
  })
})

describe('task selection helpers', () => {
  it('uses local dates and excludes completed or invalid tasks from overdue', () => {
    const original = task()
    const date = new Date(original.due_at!)
    expect(dateKey(original.due_at)).toBe(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
    expect(dateKey('invalid')).toBeNull()
    expect(isOverdue(original, date.getTime() + 1)).toBe(true)
    expect(isOverdue(original, date.getTime())).toBe(false)
    expect(isCompleted(task({ status: 'COMPLETED' }))).toBe(true)
    expect(isOverdue(task({ status: 'done' }), date.getTime() + 1)).toBe(false)
    expect(isOverdue(task({ due_at: 'invalid' }), Date.now())).toBe(false)
  })

  it('sorts day groups, puts undated last, and does not mutate inputs', () => {
    const earlier = task({ id: 'early', due_at: new Date(2025, 0, 2, 12).toISOString() })
    const later = task({ id: 'late', due_at: new Date(2025, 0, 3, 12).toISOString() })
    const undated = task({ id: 'none', due_at: null })
    const tasks = Object.freeze([Object.freeze(later), Object.freeze(undated), Object.freeze(earlier)])
    const groups = groupTasksByDay(tasks)
    expect(groups.map((group) => group.key)).toEqual(['2025-01-02', '2025-01-03', ''])
    expect(groups[2].label).toBe('No date')
    expect(groups.map((group) => group.tasks[0].id)).toEqual(['early', 'late', 'none'])
    expect(tasks.map((item) => item.id)).toEqual(['late', 'none', 'early'])
  })

  it('matches title, description, and project case insensitively', () => {
    const original = task()
    expect(taskMatchesQuery(original, ' READ ')).toBe(true)
    expect(taskMatchesQuery(original, 'notes')).toBe(true)
    expect(taskMatchesQuery(original, 'work', 'Work Project')).toBe(true)
    expect(taskMatchesQuery(original, 'missing')).toBe(false)
    expect(taskMatchesQuery(original, '')).toBe(true)
  })
})
