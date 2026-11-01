import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { AutomationView } from '../views/AutomationView'
import { DeveloperView } from '../views/DeveloperView'
import { isMacPlatform } from '../data/navigation'

const client = vi.hoisted(() => ({ agentSessions: vi.fn(), projects: vi.fn(), automations: vi.fn(), automationRuns: vi.fn(), draftAutomation: vi.fn(), createAutomation: vi.fn(), updateAutomation: vi.fn(), stopAgentSession: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(element)) }
beforeEach(() => { vi.resetAllMocks(); client.agentSessions.mockResolvedValue([]); client.projects.mockResolvedValue([]); client.automations.mockResolvedValue([]); client.automationRuns.mockResolvedValue([]) })
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

const rule = { id: 'r1', owner_id: 'o', name: 'Capture', trigger_kind: 'task.created', policy_ref: 'policy-1', enabled: true, actions: [{ type: 'create_note', token: 'private-action-data' }] }

describe('AutomationView', () => {
  it('reads each rule as When/Then with policy, last run and recent runs from the API', async () => {
    client.automations.mockResolvedValue([rule])
    client.automationRuns.mockResolvedValue([{ id: 'e1', rule_id: 'r1', rule_name: 'Capture', event_id: 'x', status: 'blocked_by_policy', attempt: 1, started_at: '2026-10-30T10:00:00Z', finished_at: null, error_code: 'POLICY_DENIED' }])
    await mount(<AutomationView apiStatus="ready" />)
    expect(host.textContent).toContain('When'); expect(host.textContent).toContain('task.created'); expect(host.textContent).toContain('create_note'); expect(host.textContent).toContain('policy-1')
    expect(host.textContent).toContain('Last run'); expect(host.textContent).toContain('Blocked by policy')
    expect(host.textContent).not.toContain('private-action-data')
  })
  it('shows honest empty states', async () => {
    await mount(<AutomationView apiStatus="ready" />)
    expect(host.textContent).toContain('No automations configured'); expect(host.textContent).toContain('No runs recorded yet')
  })
  it('labels every real run status', async () => {
    client.automations.mockResolvedValue([rule])
    client.automationRuns.mockResolvedValue((['success', 'skipped', 'blocked_by_policy', 'failed', 'running'] as const).map((status, index) => ({ id: `e${index}`, rule_id: 'r1', rule_name: 'Capture', event_id: 'x', status, attempt: 1, started_at: `2026-10-30T10:0${index}:00Z`, finished_at: null, error_code: null })))
    await mount(<AutomationView apiStatus="ready" />)
    const runs = host.querySelector('[aria-label="Recent runs"]')!.textContent!
    for (const label of ['Succeeded', 'Skipped', 'Blocked by policy', 'Failed', 'Running']) expect(runs).toContain(label)
  })
  const draft = { source: 'ai', rule: { name: 'Note new tasks', trigger_kind: 'task.created', conditions: {}, actions: [{ type: 'create_note' }], policy_ref: 'policy-1', rate_limit: {}, enabled: true }, policy: { policy_ref: 'policy-1', registered: true, allowed: true, issues: [] }, saved: false }
  const describe_ = async (text: string) => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Describe a rule"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  }
  const press = async (label: string) => act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click())
  it('drafts, reviews and saves a rule with reviewed_draft', async () => {
    client.draftAutomation.mockResolvedValue(draft); client.createAutomation.mockResolvedValue({})
    await mount(<AutomationView apiStatus="ready" />)
    await describe_('Make a note when a task is created')
    expect(client.draftAutomation).toHaveBeenCalledWith({ description: 'Make a note when a task is created' }, expect.objectContaining({ queueOnOffline: false }))
    const review = host.querySelector('[aria-label="Review rule"]')!.textContent!
    expect(review).toContain('task.created'); expect(review).toContain('create_note'); expect(review).toContain('Allowed'); expect(review).toContain('Drafted by AI'); expect(client.createAutomation).not.toHaveBeenCalled()
    await press('Save rule')
    expect(client.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ name: 'Note new tasks', reviewed_draft: true }), expect.objectContaining({ queueOnOffline: false }))
    expect(host.querySelector('[aria-label="Review rule"]')).toBeNull()
  })
  it('cancels a draft, blocks saving a disallowed policy and surfaces draft errors', async () => {
    client.draftAutomation.mockResolvedValueOnce({ ...draft, policy: { ...draft.policy, allowed: false, issues: ['Action not permitted'] } })
    await mount(<AutomationView apiStatus="ready" />)
    await describe_('do something')
    expect(host.textContent).toContain('Not allowed'); expect(host.textContent).toContain('Action not permitted')
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Save rule')!.disabled).toBe(true)
    await press('Cancel'); expect(host.querySelector('[aria-label="Review rule"]')).toBeNull()
    client.draftAutomation.mockRejectedValueOnce(new ApiError(422, 'DRAFT_UNSUPPORTED', 'This rule is not supported.'))
    await describe_('gibberish'); expect(host.textContent).toContain('DRAFT_UNSUPPORTED: This rule is not supported.')
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
    expect(host.textContent).toContain('Full transcript is stored on this Mac only.')
    expect(host.textContent).not.toContain('private-reference'); expect(host.textContent).not.toContain('Open folder')
  })
  const real = { id: 's1', adapter: 'codex_cli', state: 'active', project_id: null, opaque_local_session_ref: 'r', started_at: new Date(Date.now() - 125 * 60_000).toISOString(), last_activity_at: '2026-10-30T10:05:00Z', message_count: 4, workspace_path: '/Users/me/work/aelys', sandbox: 'workspace-write', network: 'allowlist', events: [{ kind: 'tool', message: 'ran tests', at: '2026-10-30T10:01:00Z' }] }
  it('shows the reported workspace path, sandbox, network, running time and events', async () => {
    client.agentSessions.mockResolvedValue([real])
    await mount(<DeveloperView apiStatus="ready" />)
    expect(host.querySelector('.tl-detail')!.textContent).toContain('/Users/me/work/aelys'); expect(host.textContent).toContain('workspace-write'); expect(host.textContent).toContain('Allowlist')
    expect(host.textContent).toContain('Running for2h 5m'); expect(host.querySelector('[aria-label="Event log"]')!.textContent).toContain('ran tests')
  })
  const stopButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Stop')!
  it('stops an active session and shows the policy error inline', async () => {
    client.agentSessions.mockResolvedValue([real]); client.stopAgentSession.mockRejectedValueOnce(new ApiError(403, 'POLICY_DENIED', 'Stopping is not allowed.'))
    await mount(<DeveloperView apiStatus="ready" />)
    await act(async () => stopButton().click())
    expect(client.stopAgentSession).toHaveBeenCalledWith('s1', expect.objectContaining({ queueOnOffline: false })); expect(host.textContent).toContain('POLICY_DENIED: Stopping is not allowed.')
    client.stopAgentSession.mockRejectedValueOnce(new ApiError(409, 'NO_ACTIVE_RUN', 'No active run.'))
    await act(async () => stopButton().click()); expect(host.textContent).toContain('NO_ACTIVE_RUN')
  })
  it('disables Stop for sessions that are not active', async () => {
    client.agentSessions.mockResolvedValue([{ ...real, state: 'ended' }])
    await mount(<DeveloperView apiStatus="ready" />)
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'All')!.click())
    expect(stopButton().disabled).toBe(true)
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
