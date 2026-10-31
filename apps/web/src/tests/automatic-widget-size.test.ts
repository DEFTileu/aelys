import { describe, expect, it } from 'vitest'
import { automaticWidgetSize, widgetColumns } from '../views/desktop/automaticWidgetSize'
import type { HomeData } from '../views/desktop/homeWidgets'

const empty: HomeData = { tasks: [], events: [], projects: [], notes: [], finance: [] }

describe('automatic dashboard geometry', () => {
  it('uses available container space instead of the window breakpoint', () => {
    expect(widgetColumns(1152, false)).toBe(4)
    expect(widgetColumns(744, false)).toBe(2)
    expect(widgetColumns(480, false)).toBe(1)
    expect(widgetColumns(343, true)).toBe(2)
    expect(widgetColumns(288, true)).toBe(1)
  })

  it('keeps empty cards compact and gives compact timers enough width automatically', () => {
    expect(automaticWidgetSize('today', 1152, false, empty)).toEqual({ span: 1, rows: 1, height: 176 })
    expect(automaticWidgetSize('focus', 343, true, empty)).toEqual({ span: 2, rows: 1, height: 176 })
    expect(automaticWidgetSize('focus', 288, true, empty).span).toBe(1)
  })

  it('grows lists with records and collapses them when records disappear', () => {
    const tasks: HomeData['tasks'] = Array.from({ length: 12 }, (_, index) => ({ id: String(index), title: 'Task', description: '', project_id: null, parent_task_id: null, status: 'todo', priority: 0, due_at: null, due_timezone: null, rrule: null, version: 1 }))
    expect(automaticWidgetSize('today', 1152, false, { ...empty, tasks: tasks.slice(0, 2) })).toEqual({ span: 2, rows: 1, height: 176 })
    expect(automaticWidgetSize('today', 1152, false, { ...empty, tasks: tasks.slice(0, 5) }).rows).toBe(2)
    expect(automaticWidgetSize('today', 1152, false, { ...empty, tasks }).rows).toBe(3)
    expect(automaticWidgetSize('today', 1152, false, empty).rows).toBe(1)
    expect(automaticWidgetSize('today', 1152, false, { ...empty, tasks, states: { today: 'error' } }).rows).toBe(1)
  })

  it('shows forecast detail automatically only when it is available', () => {
    expect(automaticWidgetSize('weather', 1152, false, empty, false).rows).toBe(1)
    expect(automaticWidgetSize('weather', 1152, false, empty, true).rows).toBe(2)
  })
})
