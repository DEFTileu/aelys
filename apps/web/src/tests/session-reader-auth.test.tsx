import { act, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from '../components/AuthGate'
import { DeveloperHub } from '../views/module/DeveloperHub'
import { SessionReaderAuthContext } from '../lib/sessionReaderAuth'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), status: vi.fn(), enroll: vi.fn(), login: vi.fn(), resume: vi.fn(), projects: vi.fn(), sessions: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../lib/nativeTransport', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/nativeTransport')>(),
  isNativeHost: () => true,
  loadNativeTransport: async () => ({ status: mocks.status, enroll: mocks.enroll, login: mocks.login, resume: mocks.resume }),
}))
vi.mock('../lib/api', () => ({
  getApiConfig: () => ({ baseUrl: '/api/v1' }),
  getSharedApiClient: () => ({ projects: mocks.projects, agentSessions: mocks.sessions }),
  isSignedOut: () => false, getAccessToken: () => undefined,
  setNativeCacheOwner: vi.fn(), clearNativeSignedOut: vi.fn(), startOutboxReplay: () => () => {},
  SESSION_EVENT: 'aelys:session-changed', bootstrapOwner: vi.fn(), browserAuthStatus: vi.fn(), login: vi.fn(),
  resumeBrowserSession: vi.fn(), saveApiBaseUrl: vi.fn(), claimSetupToken: vi.fn(), hasDeviceIdentity: vi.fn(), signInWithThisDevice: vi.fn(),
}))

const project = '11111111-1111-4111-8111-111111111111'
const grant = '22222222-2222-4222-8222-222222222222'
const session = '33333333-3333-4333-8333-333333333333'
const signedIn = { signed_in: true, owner_id: 'synthetic-owner', device_id: 'synthetic-device', initialized: true, can_resume: true }
const readerStatus = { available: true, persistent_grants: false, metadata_listing_available: true,
  native_confirmation_required: true, backend_identity_integrated: true, agent_execution_granted: false, os_isolation_verified: false }
let root: Root | undefined
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  mocks.status.mockResolvedValue(signedIn)
  mocks.enroll.mockResolvedValue(signedIn)
  mocks.projects.mockResolvedValue([{ id: project, name: 'Synthetic project' }])
  mocks.sessions.mockResolvedValue([])
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'session_reader_status') return readerStatus
    if (command === 'session_reader_choose_root') return { grant_id: grant, project_id: project, adapter: 'claude_code', persistent: false }
    if (command === 'session_reader_list') throw 'SIGN_IN_REQUIRED'
    if (command === 'session_reader_open') return [{ seq: 1, role: 'assistant', content: 'synthetic local text', occurred_at: null, content_truncated: false, next_cursor: null }]
    if (command === 'session_reader_search') throw 'SIGN_IN_REQUIRED'
    if (command === 'session_reader_revoke') return
    throw new Error('Unexpected IPC')
  })
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; document.body.innerHTML = ''
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function mount(children = <DeveloperHub apiStatus="ready" />) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<AuthGate apiStatus="ready">{children}</AuthGate>))
  return host
}
async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
async function reauthenticate(host: HTMLElement) {
  const token = host.querySelector<HTMLInputElement>('#aelys-entry-token')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(token, 'synthetic-one-time-code'); token.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => host.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

describe('local reader authentication boundary', () => {
  it('requires explicit native reauthentication after an authorized metadata request expires', async () => {
    const host = await mount()
    await click(host, 'Check local reader')
    await click(host, 'Choose folder & allow temporarily')
    await click(host, 'Show metadata · Approve once')
    expect(host.textContent).not.toContain('synthetic local text')
    expect(host.textContent).not.toContain('Developer Hub')
    expect(host.querySelector('#aelys-entry-token')).not.toBeNull()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.enroll).not.toHaveBeenCalled()
    await reauthenticate(host)
    expect(mocks.enroll).toHaveBeenCalledWith('http://127.0.0.1:8000', 'synthetic-one-time-code', 'Aelys Mac')
    expect(host.textContent).toContain('Developer Hub')
    expect(host.textContent).not.toContain('synthetic local text')
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'session_reader_status')).toHaveLength(1)
  })

  it('ignores a stale AuthGate callback after a replacement sign-in', async () => {
    const callbacks: Array<() => void> = []
    function Capture() {
      callbacks.push(useContext(SessionReaderAuthContext)!)
      return <div>Authenticated content</div>
    }
    const host = await mount(<Capture />)
    const oldCallback = callbacks.at(-1)!
    await act(async () => oldCallback())
    expect(host.querySelector('#aelys-entry-token')).not.toBeNull()
    await reauthenticate(host)
    expect(host.textContent).toContain('Authenticated content')
    await act(async () => oldCallback())
    expect(host.textContent).toContain('Authenticated content')
    expect(host.querySelector('#aelys-entry-token')).toBeNull()
  })
})
