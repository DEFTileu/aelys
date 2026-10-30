import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsView } from '../views/ProjectsView'

const client = vi.hoisted(() => ({ projects: vi.fn(), tasks: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), notes: vi.fn(), createTask: vi.fn(), updateTask: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const project = { id: 'p1', name: 'Project', description: 'Description', status: 'active', version: 3 }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!
async function click(label: string) { await act(async () => button(label).click()) }
beforeEach(async () => {
  vi.resetAllMocks(); client.projects.mockResolvedValue([project]); client.tasks.mockResolvedValue([]); client.notes.mockResolvedValue([])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<ProjectsView apiStatus="ready" />))
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks() })
describe('project detail actions', () => {
  it('archives with the current version and displays the returned state', async () => {
    client.updateProject.mockResolvedValue({ ...project, status: 'archived', version: 4 })
    await act(async () => host.querySelector<HTMLButtonElement>('.pv-card-open')!.click())
    await click('Archive')
    expect(client.updateProject).toHaveBeenCalledWith('p1', { status: 'archived', version: 3 }, { queueOnOffline: false })
    expect(button('Unarchive')).toBeTruthy()
  })
  it('confirms and deletes the selected project', async () => {
    client.deleteProject.mockResolvedValue({}); vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => host.querySelector<HTMLButtonElement>('.pv-card-open')!.click())
    await click('Delete')
    expect(client.deleteProject).toHaveBeenCalledWith('p1', undefined, { queueOnOffline: false })
    expect(host.textContent).toContain('No projects here')
  })
  it('creates a task in the project, toggles its version and opens a linked note', async () => {
    const task = { id: 't', title: 'Ship', description: '', project_id: 'p1', parent_task_id: null, status: 'todo', priority: 0, due_at: null, due_timezone: null, rrule: null, version: 1 }
    client.createTask.mockResolvedValue(task); client.updateTask.mockResolvedValue({ ...task, status: 'completed', version: 2 })
    client.notes.mockResolvedValue([{ id: 'n/1', title: 'Linked', markdown_body: 'Body', parent_id: null, project_id: 'p1', version: 1 }])
    await act(async () => root.render(<ProjectsView apiStatus="offline" />))
    await act(async () => root.render(<ProjectsView apiStatus="ready" />))
    await act(async () => host.querySelector<HTMLButtonElement>('.pv-card-open')!.click())
    const input = host.querySelector<HTMLInputElement>('[aria-label="Add a task to this project"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ship'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(client.createTask).toHaveBeenCalledWith({ title: 'Ship', project_id: 'p1' }, expect.objectContaining({ idempotencyKey: expect.any(String), queueOnOffline: false }))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Toggle Ship"]')!.click())
    expect(client.updateTask).toHaveBeenCalledWith('t', expect.objectContaining({ version: 1, status: 'completed', project_id: 'p1' }), { queueOnOffline: false })
    expect(host.querySelector('[aria-label="Toggle Ship"]')?.getAttribute('aria-checked')).toBe('true')
    await act(async () => host.querySelector<HTMLButtonElement>('.pv-linked button')!.click()); expect(new URLSearchParams(window.location.search).get('note')).toBe('n/1')
    window.history.replaceState({}, '', '/')
  })
  it('opens the card menu and edits the selected project', async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Project actions: Project"]')!.click())
    await click('Edit details')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Project name"]')?.value).toBe('Project')
  })

})
