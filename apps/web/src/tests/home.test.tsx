import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'

const client = vi.hoisted(() => ({ tasks: vi.fn(), calendarOccurrences: vi.fn(), projects: vi.fn(), notes: vi.fn(), financeTransactions: vi.fn(), focusSessions: vi.fn(), mailMessages: vi.fn(), activity: vi.fn(), updateTask: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

describe('HomeView', () => {
  let root: ReturnType<typeof createRoot> | undefined
  beforeEach(() => { Object.values(client).forEach((method) => method.mockRejectedValue(new Error('offline'))) })
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; window.localStorage.clear() })

  it('renders the design default My day widgets without fabricated offline data', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root?.render(<HomeView apiStatus="offline" />) })
    expect(host.textContent).toContain('My day')
    expect(host.textContent).toContain('9 widgets')
    expect(host.textContent).toContain('Records unavailable.')
    expect(host.textContent).toContain('OFFLINE_WRITE_UNAVAILABLE')
    expect(host.textContent).not.toContain('No tasks yet.')
    expect(host.querySelector('[aria-label="Dashboard widgets"]')?.children.length).toBe(9)
  })

  it('updates the actual task with its version from the Home checkbox', async () => {
    const task = { id: 'task-1', version: 4, title: 'Real task', status: 'todo', due_at: null }
    client.tasks.mockResolvedValue([task]); client.focusSessions.mockResolvedValue([])
    client.updateTask.mockResolvedValue({ ...task, status: 'completed', version: 5 })
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => root?.render(<HomeView apiStatus="ready" />))
    await act(async () => host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
    expect(client.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ version: 4, status: 'completed' }), { queueOnOffline: false })
    expect(host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
  })
})
