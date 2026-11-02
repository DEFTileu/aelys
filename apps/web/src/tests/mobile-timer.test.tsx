import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimerView } from '../views/TimerView'

const client = vi.hoisted(() => ({ focusSessions: vi.fn(), tasks: vi.fn(), projects: vi.fn(), startFocusSession: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement

// Stub the phone breakpoint so useIsMobile() picks the mobile Focus screen.
function stubMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: media === '(max-width: 700px)', media, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
}
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<TimerView apiStatus="ready" />)) }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)

beforeEach(() => {
  vi.resetAllMocks(); stubMatchMedia()
  client.focusSessions.mockResolvedValue([{ id: 's1', version: 1, started_at: new Date().toISOString(), mode: 'pomodoro', status: 'completed', elapsed_seconds: 1500, task_id: null, project_id: null }])
  client.tasks.mockResolvedValue([]); client.projects.mockResolvedValue([]); client.startFocusSession.mockResolvedValue({})
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('mobile Focus screen', () => {
  it('stacks the timer card above the session history and drops the desktop layout', async () => {
    await mount()
    expect(host.querySelector('.timer-m')).not.toBeNull()
    expect(host.querySelector('.tl')).toBeNull()
    const card = host.querySelector('[aria-label="Timer"]')!, history = host.querySelector('[aria-label="Sessions"]')!
    expect(card.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelector('.timer-m-time')?.textContent).toBe('25:00'); expect(host.textContent).toContain('1 session today')
  })
  it('starts a focus session from the mobile timer card', async () => {
    client.focusSessions.mockResolvedValue([])
    await mount()
    await act(async () => button('Start')!.click())
    expect(client.startFocusSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'pomodoro' }), expect.objectContaining({ queueOnOffline: false }))
  })
})
