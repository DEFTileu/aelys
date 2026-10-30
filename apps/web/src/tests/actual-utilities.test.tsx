import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { ModuleView, moduleConfigs } from '../views/ModuleView'
import { TimerView } from '../views/TimerView'

const client = vi.hoisted(() => ({ agentSessions: vi.fn(), automations: vi.fn(), focusSessions: vi.fn(), tasks: vi.fn(), projects: vi.fn(), startFocusSession: vi.fn(), stopFocusSession: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(element)) }
beforeEach(() => { vi.resetAllMocks(); client.agentSessions.mockResolvedValue([]); client.automations.mockResolvedValue([]); client.focusSessions.mockResolvedValue([]); client.tasks.mockResolvedValue([]); client.projects.mockResolvedValue([]) })
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

describe('utility views', () => {
  it('shows real session metadata without claiming an empty Mac is offline', async () => {
    await mount(<ModuleView config={moduleConfigs.developer} apiStatus="ready" />)
    expect(host.textContent).toContain('No sessions found'); expect(host.textContent).not.toContain('Mac runtime is offline')
    client.agentSessions.mockResolvedValue([{ id: 's1', adapter: 'codex_cli', state: 'active', opaque_local_session_ref: 'private-reference', last_activity_at: '2026-10-30' }])
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh')!.click())
    expect(host.textContent).toContain('codex_cli'); expect(host.textContent).toContain('active'); expect(host.textContent).not.toContain('private-reference')
  })
  it('shows a restricted state for policy denial without exposing server messages', async () => {
    client.automations.mockRejectedValue(new ApiError(403, 'POLICY_DENIED', 'sensitive server detail'))
    await mount(<ModuleView config={moduleConfigs.automation} apiStatus="ready" />)
    expect(host.textContent).toContain('Access restricted'); expect(host.textContent).not.toContain('sensitive server detail')
    expect(host.textContent).not.toContain('No automations configured')
  })
  it('shows returned automation policy and status without exposing action payloads', async () => {
    client.automations.mockResolvedValue([{ id: 'r1', name: 'Capture', trigger_kind: 'task.created', policy_ref: 'policy-1', enabled: false, actions: [{ token: 'private-action-data' }] }])
    await mount(<ModuleView config={moduleConfigs.automation} apiStatus="ready" />)
    expect(host.textContent).toContain('Capture'); expect(host.textContent).toContain('task.created'); expect(host.textContent).toContain('policy-1'); expect(host.textContent).toContain('Disabled')
    expect(host.textContent).not.toContain('private-action-data')
  })
  it('keeps focus writes disabled offline and reports unavailable task choices', async () => {
    client.tasks.mockRejectedValue(new Error('unavailable'))
    await mount(<TimerView apiStatus="offline" />)
    expect(host.textContent).toContain('Some task or project choices could not be loaded')
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Start focus')?.disabled).toBe(true)
    expect(client.startFocusSession).not.toHaveBeenCalled()
  })
  it('starts focus with the task selected through the shared control', async () => {
    client.tasks.mockResolvedValue([{ id: 'task-1', title: 'Prepare' }]); client.startFocusSession.mockResolvedValue({})
    await mount(<TimerView apiStatus="ready" />)
    const task = [...host.querySelectorAll<HTMLButtonElement>('[role=combobox]')].find((button) => button.textContent?.includes('No task'))!
    await act(async () => task.click())
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role=option]')].find((option) => option.textContent?.includes('Prepare'))!.click())
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Start focus')!.click())
    expect(client.startFocusSession).toHaveBeenCalledWith(expect.objectContaining({ task_id: 'task-1', mode: 'pomodoro' }), expect.objectContaining({ queueOnOffline: false, idempotencyKey: expect.any(String) }))
  })
})
