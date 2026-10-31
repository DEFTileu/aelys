import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { AutomationView } from '../views/AutomationView'
import { DeveloperView } from '../views/DeveloperView'
import { isMacPlatform } from '../data/navigation'

const client = vi.hoisted(() => ({ agentSessions: vi.fn(), projects: vi.fn(), automations: vi.fn(), automationExecutions: vi.fn(), updateAutomation: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(element)) }
beforeEach(() => { vi.resetAllMocks(); client.agentSessions.mockResolvedValue([]); client.projects.mockResolvedValue([]); client.automations.mockResolvedValue([]); client.automationExecutions.mockResolvedValue([]) })
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

const rule = { id: 'r1', owner_id: 'o', name: 'Capture', trigger_kind: 'task.created', policy_ref: 'policy-1', enabled: true, actions: [{ type: 'create_note', token: 'private-action-data' }] }

describe('AutomationView', () => {
  it('reads each rule as When/Then with policy, last run and recent runs from the API', async () => {
    client.automations.mockResolvedValue([rule])
    client.automationExecutions.mockResolvedValue([{ id: 'e1', rule_id: 'r1', event_id: 'x', run_status: 'blocked_by_policy', attempt: 1, started_at: '2026-10-30T10:00:00Z', finished_at: null, error_code: 'POLICY_DENIED' }])
    await mount(<AutomationView apiStatus="ready" />)
    expect(host.textContent).toContain('When'); expect(host.textContent).toContain('task.created'); expect(host.textContent).toContain('create_note'); expect(host.textContent).toContain('policy-1')
    expect(host.textContent).toContain('Last run'); expect(host.textContent).toContain('Blocked by policy')
    expect(host.textContent).not.toContain('private-action-data')
  })
  it('keeps rule creation disabled with a Coming soon tooltip and shows honest empty states', async () => {
    await mount(<AutomationView apiStatus="ready" />)
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Describe a rule"]')!
    expect(input.disabled).toBe(true); expect(input.title).toBe('Coming soon')
    expect(host.textContent).toContain('No automations configured'); expect(host.textContent).toContain('No runs recorded yet')
  })
  it('toggles a rule only through the API and refreshes', async () => {
    client.automations.mockResolvedValue([rule]); client.updateAutomation.mockResolvedValue({})
    await mount(<AutomationView apiStatus="ready" />)
    await act(async () => host.querySelector<HTMLButtonElement>('[role=switch]')!.click())
    expect(client.updateAutomation).toHaveBeenCalledWith('r1', { enabled: false }, expect.objectContaining({ queueOnOffline: false }))
  })
  it('shows a restricted state for policy denial without server messages', async () => {
    client.automations.mockRejectedValue(new ApiError(403, 'POLICY_DENIED', 'sensitive server detail'))
    await mount(<AutomationView apiStatus="ready" />)
    expect(host.textContent).toContain('Access restricted'); expect(host.textContent).not.toContain('sensitive server detail')
  })
})

describe('DeveloperView', () => {
  it('lists real sessions with a detail pane and never shows the local session reference', async () => {
    client.projects.mockResolvedValue([{ id: 'p1', name: 'Aelys' }])
    client.agentSessions.mockResolvedValue([{ id: 's1', adapter: 'codex_cli', state: 'active', project_id: 'p1', opaque_local_session_ref: 'private-reference', started_at: '2026-10-30T10:00:00Z', last_activity_at: '2026-10-30T10:05:00Z', message_count: 4 }])
    await mount(<DeveloperView apiStatus="ready" />)
    expect(host.textContent).toContain('codex_cli'); expect(host.textContent).toContain('Active · 1'); expect(host.textContent).toContain('Aelys')
    expect(host.textContent).toContain('4 messages exchanged'); expect(host.textContent).toContain('Full transcript is stored on this Mac only.')
    expect(host.textContent).not.toContain('private-reference'); expect(host.textContent).not.toContain('Open folder')
  })
  it('does not claim the Mac is offline when no sessions exist', async () => {
    await mount(<DeveloperView apiStatus="ready" />)
    expect(host.textContent).toContain('No sessions found'); expect(host.textContent).not.toContain('Mac runtime is offline')
  })
})

describe('Tools navigation', () => {
  it('detects macOS for the Developer Hub entry', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get')
    platform.mockReturnValue('MacIntel'); expect(isMacPlatform()).toBe(true)
    platform.mockReturnValue('Win32'); expect(isMacPlatform()).toBe(false)
    platform.mockRestore()
  })
})
