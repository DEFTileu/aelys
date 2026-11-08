import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'
import { AiMobile } from '../views/ai/AiView.mobile'

const client = vi.hoisted(() => ({ aiCapabilities: vi.fn(), aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), createAIConversation: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn() }))
const identity = vi.hoisted(() => ({ partition: '' }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client, getDraftPartition: async (kind: string) => JSON.stringify(["web", "backend", identity.partition, kind]), getAccessToken: () => 'test' }))
let root: Root
let host: HTMLDivElement
async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<AiView apiStatus="ready" />))
}
async function unmount() { await act(async () => root.unmount()); host.remove() }
async function fill(value: string) {
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.trim().startsWith(text))!.click()) }
beforeEach(() => {
  vi.resetAllMocks(); identity.partition = crypto.randomUUID()
  client.aiCapabilities.mockResolvedValue({ conversation_create_idempotency: true })
  client.aiProviders.mockResolvedValue([{ id: 'p1', kind: 'claude', enabled: true, has_secret: true, model_policy: {} }]); client.aiConversations.mockResolvedValue([])
  client.aiMessages.mockResolvedValue([]); client.createAIConversation.mockResolvedValue({ id: 'c1', title: 'Chat' })
})
afterEach(async () => { if (host?.isConnected) await unmount() })
it('restores an unconfirmed request after remount with the same body and key', async () => {
  client.aiConversations.mockResolvedValue([{ id: 'c1', title: 'Chat' }])
  client.createAIRun.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ id: 'r1', conversation_id: 'c1' })
  client.aiRunEvents.mockResolvedValue(new Response('event: ai.run.completed\ndata: {}\n\n'))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Create a task'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same request'))
  await unmount(); await mount()
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same request'))
  await click('Retry same request')
  expect(client.createAIRun).toHaveBeenCalledTimes(2)
  expect(client.createAIRun.mock.calls[1]).toEqual(client.createAIRun.mock.calls[0])
  expect(client.createAIConversation).toHaveBeenCalledTimes(1)
  await unmount(); await mount()
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  expect(host.textContent).not.toContain('Retry same request')
})

it('does not send a run when local recovery storage cannot be opened', async () => {
  const failure = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('storage unavailable') })
  try {
    await mount()
    await vi.waitFor(() => expect(host.textContent).toContain('Local recovery storage is unavailable'))
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(true)
    expect(client.createAIRun).not.toHaveBeenCalled()
  } finally { failure.mockRestore() }
})

it('restores a conversation creation after a lost response without changing either key', async () => {
  client.createAIConversation.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ id: 'c1', title: 'Chat' })
  client.createAIRun.mockResolvedValue({ id: 'r1', conversation_id: 'c1' })
  client.aiRunEvents.mockResolvedValue(new Response('event: ai.run.completed\ndata: {}\n\n'))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Recover this conversation'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same request'))
  await unmount(); await mount(); await vi.waitFor(() => expect(host.textContent).toContain('Retry same request'))
  await click('Retry same request')
  await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalledTimes(1))
  expect(client.createAIConversation).toHaveBeenCalledTimes(2)
  expect(client.createAIConversation.mock.calls[1]).toEqual(client.createAIConversation.mock.calls[0])
  expect(client.createAIRun.mock.calls[0]![0].conversation_id).toBe('c1')
})

it('does not retry conversation creation against a server without the capability', async () => {
  client.createAIConversation.mockRejectedValueOnce(new Error('response lost'))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Test'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same request'))
  client.aiCapabilities.mockResolvedValue({ conversation_create_idempotency: false })
  await click('Retry same request')
  expect(client.createAIConversation).toHaveBeenCalledTimes(1)
  expect(client.createAIRun).not.toHaveBeenCalled()
})

it.each([
  ['failed', 'Provider failed'],
  ['cancelled', 'Stopped'],
] as const)('keeps partial output visible when a run is %s', async (status, terminalLabel) => {
  client.createAIRun.mockResolvedValue({ id: 'r1', conversation_id: 'c1' })
  client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Question' }])
  client.aiRunEvents.mockResolvedValue(new Response(`event: ai.text.delta\ndata: {"text":"Partial answer"}\n\nevent: ai.run.${status}\ndata: {}\n\n`))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Question'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(host.textContent).toContain(terminalLabel))
  expect(host.textContent).toContain('Partial answer')
  expect(host.textContent).toContain('Question')
})

it('does not expose a pending prompt after an owner change', async () => {
  client.createAIRun.mockRejectedValue(new Error('response lost'))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Private owner A'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same request'))
  identity.partition = crypto.randomUUID()
  await act(async () => window.dispatchEvent(new Event('aelys:session-changed')))
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.value).toBe('')
  expect(host.textContent).not.toContain('Retry same request')
  expect(host.textContent).not.toContain('Private owner A')
})

it('unblocks the composer when starting a new chat while history is loading', async () => {
  let finish!: (value: unknown[]) => void
  client.aiConversations.mockResolvedValue([{ id: 'c-old', title: 'Old chat' }])
  client.aiMessages.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await click('Old chat')
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(true)
  await click('New chat')
  await act(async () => finish([{ id: 'm-old', role: 'assistant', content: 'Old response' }]))
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false)
  expect(host.textContent).not.toContain('Old response')
})

it('does not stream a late run response after a session change', async () => {
  let finish!: (value: { id: string; conversation_id: string }) => void
  client.createAIRun.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await mount(); await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Private question'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalledTimes(1))
  identity.partition = crypto.randomUUID()
  await act(async () => window.dispatchEvent(new Event('aelys:session-changed')))
  await act(async () => finish({ id: 'late-run', conversation_id: 'c1' }))
  expect(client.aiRunEvents).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('Private question')
})

it.each(['creation', 'stream'])('keeps mobile New disabled during %s recovery', async state => {
  if (state === 'creation') client.createAIRun.mockRejectedValue(new Error('lost'))
  else {
    client.createAIRun.mockResolvedValue({ id: 'r1', conversation_id: 'c1' })
    client.aiRunEvents.mockResolvedValue(new Response('event: ai.text.delta\ndata: {"text":"partial"}\n\n'))
  }
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<AiMobile apiStatus="ready" />))
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await fill('Create a task'); await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(host.textContent).toContain(state === 'creation' ? 'Retry same request' : 'Check run status'))
  expect(host.querySelector<HTMLButtonElement>('.actual-ai__new')?.disabled).toBe(true)
})
