import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsView } from '../views/ProjectsView'

const client = vi.hoisted(() => ({ projects: vi.fn(), tasks: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), notes: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), createProject: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const project = { id: 'p1', name: 'Project', description: 'Description', status: 'active', version: 3 }
const originalMatchMedia = window.matchMedia
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim().includes(label))!
async function click(element: HTMLElement) { await act(async () => element.click()) }

beforeEach(async () => {
  vi.resetAllMocks()
  window.matchMedia = vi.fn((query: string) => ({ matches: query === '(max-width: 700px)', media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
  client.projects.mockResolvedValue([project]); client.tasks.mockResolvedValue([]); client.notes.mockResolvedValue([])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<ProjectsView apiStatus="ready" />))
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; window.matchMedia = originalMatchMedia; vi.restoreAllMocks() })

describe('mobile projects', () => {
  it('renders the card list and never the desktop layout', () => {
    expect(host.querySelector('.projects-m')).not.toBeNull()
    expect(host.querySelector('.projects-view')).toBeNull()
    expect(host.querySelectorAll('.projects-m-card')).toHaveLength(1)
    expect(host.querySelector('[aria-label="New project"]')).not.toBeNull()
  })

  it('opens a detail screen and returns to the list with Back', async () => {
    await click(host.querySelector<HTMLButtonElement>('.projects-m-card')!)
    expect(host.querySelector('.projects-m-detail')).not.toBeNull()
    expect(host.querySelector('.projects-m-card')).toBeNull()
    await click(host.querySelector<HTMLButtonElement>('.projects-m-back')!)
    expect(host.querySelectorAll('.projects-m-card')).toHaveLength(1)
  })

  it('archives from the detail screen with the current version', async () => {
    client.updateProject.mockResolvedValue({ ...project, status: 'archived', version: 4 })
    await click(host.querySelector<HTMLButtonElement>('.projects-m-card')!)
    await click(button('Archive'))
    expect(client.updateProject).toHaveBeenCalledWith('p1', { status: 'archived', version: 3 }, { queueOnOffline: false })
  })

  it('opens the new project sheet from the FAB', async () => {
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New project"]')!)
    expect(host.querySelector('[role="dialog"][aria-label="New project"]')).not.toBeNull()
  })
})
