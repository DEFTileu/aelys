import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'

const client = vi.hoisted(() => ({ aiCapabilities: vi.fn(), aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), createAIConversation: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn() }))
const identity = vi.hoisted(() => ({ partition: '' }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client, getDraftPartition: async (kind: string) => JSON.stringify(['web', 'backend', identity.partition, kind]) }))

describe('AI chat layout controls', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.resetAllMocks() })

  it('filters real conversation titles and starts a chat from a suggestion card', async () => {
    identity.partition = crypto.randomUUID()
    client.aiCapabilities.mockResolvedValue({ conversation_create_idempotency: true })
    client.aiProviders.mockResolvedValue([{ id: 'p1', kind: 'claude', enabled: true, has_secret: true }])
    client.aiConversations.mockResolvedValue([{ id: 'c1', title: 'Planning' }, { id: 'c2', title: 'Reading notes' }])
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root?.render(<AiView apiStatus="ready" />) })
    await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.getAttribute('aria-label')).toBe('Send message')
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'reading'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    const list = host.querySelector('[aria-label="Conversation list"]')!
    expect(list.textContent).toContain('Reading notes')
    expect(list.textContent).not.toContain('Planning')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'zzz'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(list.textContent).toContain('No chats match “zzz”')
    expect(client.createAIConversation).not.toHaveBeenCalled()
    client.createAIConversation.mockResolvedValue({ id: 'c3', title: 'Plan my day around my tasks and calendar' })
    client.createAIRun.mockResolvedValue({ id: 'r1' })
    client.aiRunEvents.mockResolvedValue(new Response('event: ai.run.completed\ndata: {"run_id":"r1"}\n\n'))
    client.aiMessages.mockResolvedValue([])
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Plan my day'))!.click() })
    await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalled())
    expect(client.createAIConversation).toHaveBeenCalledWith(expect.any(Object), { queueOnOffline: false, idempotencyKey: expect.any(String) })
    expect(client.createAIRun).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c3', message: 'Plan my day around my tasks and calendar', idempotency_key: expect.any(String) }), { queueOnOffline: false, idempotencyKey: expect.any(String) })
    expect(client.createAIRun.mock.calls[0]![1].idempotencyKey).toBe(client.createAIRun.mock.calls[0]![0].idempotency_key)
  })
})
