import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModuleView, moduleConfigs } from '../views/ModuleView'
import { AutomationView } from '../views/AutomationView'
import { DeveloperView } from '../views/DeveloperView'

const client = vi.hoisted(() => ({ projects: vi.fn(), automations: vi.fn(), automationRuns: vi.fn(), agentSessions: vi.fn(), createProject: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement

// Stub the phone breakpoint so useIsMobile() picks the mobile list layout.
function stubMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: media === '(max-width: 700px)', media, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
}
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(element)) }

beforeEach(() => {
  vi.resetAllMocks(); stubMatchMedia()
  client.projects.mockResolvedValue([{ id: 'p1', name: 'Alpha', status: 'active' }, { id: 'p2', name: 'Beta', status: 'archived' }])
  client.automations.mockResolvedValue([]); client.automationRuns.mockResolvedValue([]); client.agentSessions.mockResolvedValue([])
  client.createProject.mockResolvedValue({})
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('mobile module list', () => {
  it('renders one list with search, status chips and a FAB that opens the create sheet', async () => {
    await mount(<ModuleView config={moduleConfigs.projects} apiStatus="ready" />)
    expect(host.querySelector('.module-m')).not.toBeNull(); expect(host.querySelector('.mod-screen')).toBeNull()
    expect(host.querySelectorAll('.module-m-row').length).toBe(2)
    expect([...host.querySelectorAll('.module-m-chips button')].map((chip) => chip.textContent)).toEqual(['All', 'active', 'archived'])
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New project"]')!.click())
    expect(host.querySelector('[role="dialog"][aria-label="New project"]')).not.toBeNull()
  })
  it('has no create FAB for locked modules', async () => {
    await mount(<ModuleView config={moduleConfigs.automation} apiStatus="ready" />)
    expect(host.querySelector('.module-m')).not.toBeNull()
    expect(host.querySelector('.module-m-fab')).toBeNull()
  })
  it('gives Automation and Developer the mobile root with their own single-column rules', async () => {
    await mount(<AutomationView apiStatus="ready" />)
    expect(host.querySelector('.au.au-m')).not.toBeNull()
    act(() => root!.unmount()); document.body.innerHTML = ''
    await mount(<DeveloperView apiStatus="ready" />)
    expect(host.querySelector('.tl.dev-m')).not.toBeNull()
  })
})
