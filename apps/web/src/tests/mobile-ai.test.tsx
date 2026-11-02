import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'

const client = vi.hoisted(() => ({ aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const mobileOnly = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', addEventListener() {}, removeEventListener() {} }))

beforeEach(async () => {
  vi.resetAllMocks()
  client.aiProviders.mockResolvedValue([{ id: 'p', kind: 'claude', enabled: true, has_secret: true, model_policy: {} }])
  client.aiConversations.mockResolvedValue([{ id: 'one', title: 'First chat' }])
  client.aiMessages.mockResolvedValue([])
  mobileOnly()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<AiView apiStatus="ready" />))
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('mobile AI chat', () => {
  it('renders the mobile chat screen instead of the desktop layout', () => {
    expect(host.querySelector('.ai-m')).not.toBeNull()
    expect(host.querySelector('.actual-ai')).toBeNull()
    expect(host.querySelector('.actual-ai__compose textarea')).not.toBeNull()
  })
  it('switches between the chat and the conversation list screens', async () => {
    const toggle = () => host.querySelector<HTMLButtonElement>('.ai-m-head button[aria-expanded]')!
    await act(async () => toggle().click())
    expect(host.querySelector('[aria-label="Conversation list"]')).not.toBeNull()
    expect(host.querySelector('.actual-ai__compose')).toBeNull()
    await act(async () => toggle().click())
    expect(host.querySelector('.actual-ai__compose')).not.toBeNull()
  })
})
