import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'
import { TelegramSettings } from '../views/TelegramSettings'
import { modelsFor, resolveChoice } from '../data/aiModels'

const client = vi.hoisted(() => ({
  aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), createAIConversation: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn(), cancelAIRun: vi.fn(),
  telegramStatus: vi.fn(), telegramMessages: vi.fn(), updateTelegramSettings: vi.fn(),
}))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const claude = { id: 'p1', kind: 'claude', enabled: true, has_secret: true, model_policy: {} } as const
const openrouter = { id: 'p2', kind: 'openrouter', enabled: true, has_secret: false, model_policy: {} } as const
const sse = (...events: readonly (readonly [string, object])[]) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const find = (text: string, selector = 'button') => [...host.querySelectorAll<HTMLElement>(selector)].find((item) => item.textContent?.includes(text))!
const click = (element: HTMLElement) => act(async () => element.click())
async function type(label: string, value: string) {
  const field = host.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const completed = (text = 'Hi', cost = '0.0042') => sse(['ai.run.started', { run_id: 'r', provider: 'claude', model: 'claude-sonnet-4-5' }], ['ai.text.delta', { text }], ['ai.run.completed', { run_id: 'r', text_length: 2, estimated_cost: cost }])

beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks()
  client.aiProviders.mockResolvedValue([claude, openrouter])
  client.aiConversations.mockResolvedValue([])
  client.createAIConversation.mockResolvedValue({ id: 'c1', title: 'Hello' })
  client.createAIRun.mockResolvedValue({ id: 'run1' })
  client.aiRunEvents.mockImplementation(async () => completed())
  client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Hello' }, { id: 'a1', role: 'assistant', content: 'Hi' }])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = '' })
const mountChat = async () => act(async () => root.render(<AiView apiStatus="ready" />))

describe('model catalog', () => {
  it('uses the catalog per provider kind and lets model_policy.models override it', () => {
    expect(modelsFor(claude).map((item) => item.id)).toContain('claude-sonnet-4-5')
    const custom = modelsFor({ kind: 'claude', model_policy: { models: ['claude-haiku-4-5', 'my-model'] } })
    expect(custom.map((item) => item.id)).toEqual(['claude-haiku-4-5', 'my-model'])
    expect(custom[0]!.name).toBe('Haiku 4.5')
  })
  it('falls back to the first ready provider when the stored one lost its key', () => {
    expect(resolveChoice({ providerId: 'gone', model: 'x' }, [claude as never]).providerId).toBe('p1')
  })
})

describe('AI chat model picker and run states', () => {
  it('shows keyless providers disabled with Add key, remembers the choice per chat and sends effort', async () => {
    await mountChat()
    await click(find('Auto'))
    const dialog = host.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('Add key')
    expect(dialog.querySelector<HTMLButtonElement>('[role=option][aria-disabled=true]')!.disabled).toBe(true)
    await click(find('Sonnet 4.5', '[role=option]'))
    await click(find('High', '[role=radio]'))
    await click(find('Use for new chats', 'label').querySelector('input')!)
    expect(JSON.parse(localStorage.getItem('aelys.chat.defaultModel')!)).toMatchObject({ providerId: 'p1', model: 'claude-sonnet-4-5' })
    await type('Message Aelys', 'Hello')
    await click(host.querySelector<HTMLElement>('[aria-label="Send message"]')!)
    expect(client.createAIRun.mock.calls[0]![0].routing).toEqual({ provider_id: 'p1', provider: 'claude', model: 'claude-sonnet-4-5', effort: 'high' })
    expect(JSON.parse(localStorage.getItem('aelys.chat.c1.model')!).model).toBe('claude-sonnet-4-5')
    expect(host.querySelector('.actual-ai__meta')!.textContent).toBe('Claude · claude-sonnet-4-5 · 0.0s · ≈$0.0042 · high effort')
  })

  it('does not offer reasoning effort for models without thinking', async () => {
    await mountChat()
    await click(find('Auto')); await click(find('Haiku 4.5', '[role=option]'))
    expect(host.querySelector('[aria-label="Reasoning effort"]')).toBeNull()
  })

  it('regenerates with the same message and replaces the old answer in the view', async () => {
    await mountChat()
    await type('Message Aelys', 'Hello'); await click(host.querySelector<HTMLElement>('[aria-label="Send message"]')!)
    client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Hello' }, { id: 'a1', role: 'assistant', content: 'Hi' }, { id: 'u2', role: 'user', content: 'Hello' }, { id: 'a2', role: 'assistant', content: 'Second' }])
    client.aiRunEvents.mockImplementation(async () => completed('Second'))
    await click(host.querySelector<HTMLElement>('[aria-label="Regenerate"]')!)
    expect(client.createAIRun).toHaveBeenCalledTimes(2)
    expect(client.createAIRun.mock.calls[1]![0]).toMatchObject({ message: 'Hello', conversation_id: 'c1', routing: { provider_id: 'p1' } })
    const text = host.querySelector('.actual-ai__lines')!.textContent!
    expect(text).toContain('Second'); expect(text).not.toContain('Hi')
    expect(host.querySelectorAll('.actual-ai__line--user')).toHaveLength(1)
  })

  it('keeps partial text with a Stopped label when the run is cancelled', async () => {
    client.aiRunEvents.mockImplementation(async () => sse(['ai.run.started', { provider: 'claude', model: 'm' }], ['ai.text.delta', { text: 'Partial answer' }], ['ai.run.cancelled', { run_id: 'r' }]))
    client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Hello' }])
    await mountChat()
    await type('Message Aelys', 'Hello'); await click(host.querySelector<HTMLElement>('[aria-label="Send message"]')!)
    expect(host.querySelector('.actual-ai__lines')!.textContent).toContain('Partial answer')
    expect(host.querySelector('.actual-ai__stopped')!.textContent).toBe('Stopped')
  })

  it('shows an error card from ai.run.failed and Retry sends the same message again', async () => {
    client.aiRunEvents.mockImplementationOnce(async () => sse(['ai.run.failed', { code: 'PROVIDER_DOWN', message: 'Provider is down' }]))
    client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Hello' }])
    await mountChat()
    await type('Message Aelys', 'Hello'); await click(host.querySelector<HTMLElement>('[aria-label="Send message"]')!)
    const card = host.querySelector('.actual-ai__error')!
    expect(card.textContent).toContain('Provider is down'); expect(card.textContent).toContain('PROVIDER_DOWN')
    expect(card.textContent).toContain('Try Haiku 4.5')
    await click(find('Retry'))
    expect(client.createAIRun).toHaveBeenCalledTimes(2)
    expect(client.createAIRun.mock.calls[1]![0].message).toBe('Hello')
    expect(host.querySelector('.actual-ai__error')).toBeNull()
  })

  it('shows three dots until the first text delta', async () => {
    let release!: () => void
    client.aiRunEvents.mockImplementation(() => new Promise((resolve) => { release = () => resolve(completed()) }))
    await mountChat()
    await type('Message Aelys', 'Hello'); await click(host.querySelector<HTMLElement>('[aria-label="Send message"]')!)
    expect(host.querySelector('[aria-label="Aelys is thinking"]')).not.toBeNull()
    await act(async () => release())
    expect(host.querySelector('[aria-label="Aelys is thinking"]')).toBeNull()
  })
})

describe('Telegram Reply with', () => {
  it('uses the compact picker and saves provider_id plus model', async () => {
    const status = { configured: true, id: 'bot', version: 3, enabled: true, auto_reply: true, provider_id: null, model: null, instructions: '', connections: [], timezone: 'UTC', reply_delay_seconds: 90, business_capable: true, owner_telegram_id: null, last_polled_at: null, last_error_code: null }
    client.telegramStatus.mockResolvedValue(status); client.telegramMessages.mockResolvedValue([])
    client.updateTelegramSettings.mockResolvedValue({ ...status, version: 4 })
    await act(async () => root.render(<TelegramSettings />))
    await click(host.querySelector<HTMLElement>('button[aria-label="Reply with"]')!)
    expect(host.querySelector('[role=dialog]')!.textContent).not.toContain('Reasoning effort')
    await click(find('Sonnet 4.5', '[role=option]'))
    await click(find('Save settings'))
    expect(client.updateTelegramSettings).toHaveBeenCalledWith({ version: 3, instructions: '', provider_id: 'p1', model: 'claude-sonnet-4-5' })
  })
})
