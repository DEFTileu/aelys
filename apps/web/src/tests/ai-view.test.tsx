import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'
import { askAelys } from '../lib/desktopStore'

const client = vi.hoisted(() => ({ aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const buttons = (text: string) => [...host.querySelectorAll('button')].filter((item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)
async function click(text: string) { await act(async () => buttons(text)[0]!.click()) }
async function fill(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
beforeEach(async () => {
  vi.resetAllMocks()
  client.aiProviders.mockResolvedValue([{ id: 'p', kind: 'claude', enabled: true, has_secret: true, model_policy: {} }])
  client.aiConversations.mockResolvedValue([{ id: 'one', title: 'First chat' }, { id: 'two', title: 'Second chat' }])
  client.aiMessages.mockResolvedValue([{ id: 'u', role: 'user', content: 'Hi <b>there</b>', created_at: '2026-10-29T12:00:00Z' }, { id: 'm', role: 'assistant', content: '<script>hello</script>' }])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<AiView apiStatus="ready" />))
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })
describe('AI chat workspace', () => {
  it('searches real conversations, opens the list on a phone and renders messages safely', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }))
    act(() => root.unmount()); root = createRoot(host)
    await act(async () => root.render(<AiView apiStatus="ready" />))
    await click('All chats'); expect(host.querySelector('.actual-ai--history-open')).not.toBeNull()
    await fill('Search conversations', 'Second')
    expect(host.querySelector('.actual-ai__list')?.textContent).not.toContain('First chat')
    await click('Second chat')
    expect(client.aiMessages).toHaveBeenCalledWith('two')
    expect(host.querySelector('.actual-ai--history-open')).toBeNull()
    expect(host.querySelector('.actual-ai__answer script')).toBeNull()
    expect(host.querySelector('.actual-ai__answer .actual-ai__bubble')?.textContent).toContain('<script>hello</script>')
    expect(host.querySelector('.actual-ai__line--user .actual-ai__bubble')?.textContent).toBe('Hi <b>there</b>')
    expect(host.querySelector('.actual-ai__line--user time')?.getAttribute('datetime')).toBe('2026-10-29T12:00:00Z')
  })
  it('starts a new chat from the list', async () => {
    await click('First chat'); await click('New chat')
    expect(host.querySelector('.actual-ai__thread-head h2')?.textContent).toBe('New conversation')
    expect(host.querySelector('.actual-ai__welcome h2')?.textContent).toContain('What can I help with')
  })
})

it('keeps a Knowledge handoff and its scope through StrictMode effect replay', async () => {
  act(() => root.unmount())
  askAelys('Explain this source', { note_ids: ['note-1'] })
  root = createRoot(host)
  await act(async () => root.render(<StrictMode><AiView apiStatus="ready" /></StrictMode>))
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.value).toBe('Explain this source')
  expect(host.textContent).toContain('selected document')
})
