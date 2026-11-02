import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ProjectResponse, TaskOut } from '@aelys/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksView } from '../views/TasksView'

const client = vi.hoisted(() => ({ tasks: vi.fn(), projects: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), task: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const project: ProjectResponse = { id: 'project-1', name: 'Orion', description: '', status: 'active', version: 1 }
function task(overrides: Partial<TaskOut> = {}): TaskOut {
  return { id: 'task-1', version: 4, title: 'Plan launch', description: '', project_id: 'project-1', parent_task_id: null, status: 'todo', priority: 2, due_at: null, due_timezone: null, rrule: null, ...overrides }
}

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }))
  client.tasks.mockResolvedValue([task()])
  client.projects.mockResolvedValue([project])
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

async function mountMobile() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<TasksView apiStatus="ready" />))
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((tab) => tab.textContent?.startsWith('Inbox'))!.click())
}
function buttonByLabel(label: string) {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}

describe('mobile tasks screen', () => {
  it('renders the mobile root instead of the desktop workspace', async () => {
    await mountMobile()
    expect(host.querySelector('.tasks-m')).not.toBeNull()
    expect(host.querySelector('.tasks-screen')).toBeNull()
    expect(host.querySelector('[data-task-row="task-1"]')).not.toBeNull()
  })

  it('shows the add button and opens the task editor as a sheet', async () => {
    await mountMobile()
    expect(host.querySelector('.tasks-m-fab')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open task: Plan launch"]')!.click())
    expect(host.querySelector('.tasks-m .task-editor__dialog[role="dialog"]')).not.toBeNull()
  })

  it('opens the filters as a bottom sheet', async () => {
    await mountMobile()
    await act(async () => buttonByLabel('Filters').click())
    expect(host.querySelector('.tasks-m-sheet[role="dialog"]')).not.toBeNull()
  })
})
