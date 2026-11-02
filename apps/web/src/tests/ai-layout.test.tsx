import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'

const client = vi.hoisted(() => ({ aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), createAIConversation: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

describe('AI chat layout controls', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.resetAllMocks() })

  it('filters real conversation titles and starts a chat from a suggestion card', async () => {
    client.aiProviders.mockResolvedValue([{ id: 'p1', kind: 'claude', enabled: true, has_secret: true }])
    client.aiConversations.mockResolvedValue([{ id: 'c1', title: 'Planning' }, { id: 'c2', title: 'Reading notes' }])
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root?.render(<AiView apiStatus="ready" />) })
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
    expect(client.createAIRun.mock.calls[0]![0]).toMatchObject({ conversation_id: 'c3', message: 'Plan my day around my tasks and calendar' })
  })
})
