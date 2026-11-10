import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'
import { formatCost, groupConversations, scopesFor, sourcesOn, whenLabel } from '../views/ai/chatModel'

const client = vi.hoisted(() => ({
  aiCapabilities: vi.fn(), aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), createAIConversation: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn(), cancelAIRun: vi.fn(),
  updateAIConversation: vi.fn(), aiConversationActions: vi.fn(), approveAIAction: vi.fn(), rejectAIAction: vi.fn(), uploadAIAttachment: vi.fn(), deleteAIAttachment: vi.fn(), setAIMessageFeedback: vi.fn(),
}))
const identity = vi.hoisted(() => ({ partition: '' }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client, getDraftPartition: async (kind: string) => JSON.stringify(['web', 'backend', identity.partition, kind]) }))
const claude = { id: 'p1', kind: 'claude', enabled: true, has_secret: true, model_policy: {} }
const sse = (...events: readonly (readonly [string, object])[]) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''))
const day = (offset: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - offset, 12).toISOString()
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
// document, not host: the model picker popover is portaled to body.
const find = (text: string, selector = 'button') => [...document.querySelectorAll<HTMLElement>(selector)].find((item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)!
const click = (element: HTMLElement) => act(async () => element.click())
async function type(value: string) {
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const send = async (value: string) => {
  await type(value); await click(host.querySelector<HTMLElement>('[aria-label="Send message"]')!)
  await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalled())
  const [body, options] = client.createAIRun.mock.calls.at(-1)!
  expect(options).toMatchObject({ queueOnOffline: false, idempotencyKey: expect.any(String) })
  expect(options.idempotencyKey).toBe(body.idempotency_key)
}
const labels = () => [...host.querySelectorAll('.actual-ai__list-label')].map((item) => item.textContent)
const side = () => host.querySelector<HTMLElement>('[aria-label="Chat resources"]')!
const switches = (scope: ParentNode = side()) => Object.fromEntries([...scope.querySelectorAll('[role=switch]')].map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-checked')]))

const chats = [
  { id: 'pin', title: 'INF 376 project outline', pinned: true, updated_at: day(3), preview: 'Sentiment analysis of Kazakh reviews' },
  { id: 'today', title: 'Plan for today', updated_at: new Date().toISOString(), preview: 'Here is a realistic plan', tool_scope_json: { scopes: ['tasks.read', 'calendar.read'] }, usage: { input_tokens: 1200, output_tokens: 300, estimated_cost: '0.0042' } },
  { id: 'yes', title: 'Budget for November', updated_at: day(1), preview: 'Based on October' },
  { id: 'week', title: 'Trip to Shymkent', updated_at: day(4), preview: 'Light jacket' },
  { id: 'old', title: 'Old idea', updated_at: day(30), preview: 'Something' },
]

beforeEach(async () => {
  localStorage.clear(); vi.resetAllMocks()
  identity.partition = crypto.randomUUID()
  client.aiCapabilities.mockResolvedValue({ conversation_create_idempotency: true })
  localStorage.setItem('aelys.chat.defaultModel', JSON.stringify({ providerId: 'p1', model: 'claude-sonnet-4-5' }))
  client.aiProviders.mockResolvedValue([claude])
  client.aiConversations.mockResolvedValue(chats)
  client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Plan my day' }, { id: 'a1', role: 'assistant', content: 'Here is the plan', feedback: null }])
  client.aiConversationActions.mockResolvedValue([])
  client.createAIConversation.mockResolvedValue({ id: 'new', title: 'Hello' })
  client.createAIRun.mockResolvedValue({ id: 'run1' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<AiView apiStatus="ready" />))
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = '' })

describe('chat model helpers', () => {
  it('groups Pinned, Today, Yesterday, Previous 7 days and Earlier and labels the time', () => {
    const now = new Date()
    expect(groupConversations(chats as never, now).map((group) => group.title)).toEqual(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Earlier'])
    expect(whenLabel(chats[2] as never, now)).toBe('Yesterday')
    expect(whenLabel(chats[0] as never, now)).toBe('')
  })
  it('reads scopes, keeps unknown ones on write and formats cost', () => {
    const chat = { tool_scope_json: { scopes: ['tasks.read', 'mail.read'] } }
    expect([...sourcesOn(chat)]).toEqual(['tasks'])
    expect(scopesFor(new Set(['notes']), chat)).toEqual(['mail.read', 'notes.read'])
    expect([...sourcesOn(undefined)]).toEqual(['tasks', 'calendar', 'notes'])
    expect([formatCost('0.0042'), formatCost(0.5), formatCost(0)]).toEqual(['< $0.01', '≈ $0.50', ''])
  })
})

describe('chat list', () => {
  it('shows the groups with a preview and pins a chat through the API', async () => {
    expect(labels()).toEqual(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Earlier'])
    expect(host.querySelector('.actual-ai__list')!.textContent).toContain('Sentiment analysis of Kazakh reviews')
    client.updateAIConversation.mockResolvedValue({ ...chats[1], pinned: true })
    await click(find('Pin Plan for today'))
    expect(client.updateAIConversation).toHaveBeenCalledWith('today', { pinned: true })
    expect(find('Unpin Plan for today')).toBeTruthy()
    expect(labels()).toEqual(['Pinned', 'Yesterday', 'Previous 7 days', 'Earlier'])
  })
})

describe('What Aelys can see', () => {
  it('offers only real sources with switches and saves a toggle as scopes', async () => {
    await click(find('Plan for today', '.actual-ai__conversation-main'))
    expect(switches()).toEqual({ Tasks: 'true', Calendar: 'true', Notes: 'false', 'Knowledge base': 'false' })
    expect(find('2 sources')).toBeTruthy()
    client.updateAIConversation.mockResolvedValue({ ...chats[1], tool_scope_json: { scopes: ['tasks.read', 'calendar.read', 'notes.read'] } })
    await click(side().querySelector<HTMLElement>('[aria-label="Notes"]')!)
    expect(client.updateAIConversation).toHaveBeenCalledWith('today', { scopes: ['tasks.read', 'calendar.read', 'notes.read'] })
    expect(find('3 sources')).toBeTruthy()
  })
  it('opens the same list from the composer chip and says No sources when all are off', async () => {
    await click(find('3 sources'))
    const dialog = host.querySelector<HTMLElement>('[role=dialog][aria-label="What Aelys can see"]')!
    expect(Object.keys(switches(dialog))).toEqual(['Tasks', 'Calendar', 'Notes', 'Knowledge base'])
    for (const name of ['Tasks', 'Calendar', 'Notes']) await click(dialog.querySelector<HTMLElement>(`[aria-label="${name}"]`)!)
    expect(find('No sources')).toBeTruthy()
  })
  it('saves sources toggled before the first message onto the new chat', async () => {
    await click(find('3 sources')); await click(host.querySelector<HTMLElement>('[role=dialog] [aria-label="Notes"]')!)
    client.updateAIConversation.mockResolvedValue({ id: 'new', title: 'Hello', tool_scope_json: { scopes: ['tasks.read', 'calendar.read'] } })
    client.aiRunEvents.mockImplementation(async () => sse(['ai.run.completed', { run_id: 'run1' }]))
    await send('Hello')
    expect(client.updateAIConversation).toHaveBeenCalledWith('new', { scopes: ['tasks.read', 'calendar.read'] })
  })
})

describe('This chat', () => {
  it('shows cost, tokens of the context window with a bar, model and messages', async () => {
    await click(find('Plan for today', '.actual-ai__conversation-main'))
    const card = host.querySelector<HTMLElement>('.actual-ai__chatinfo')!
    expect(card.textContent).toContain('< $0.01')
    expect(card.textContent).toContain('of 200K context')
    expect(card.querySelector('[role=progressbar]')).not.toBeNull()
    expect(card.textContent).toContain('Claude Sonnet 4.5')
    expect(card.querySelector('dl')!.textContent).toContain('Messages2')
  })
})

describe('run steps, action card and answer actions', () => {
  const run = () => sse(
    ['ai.run.started', { run_id: 'run1', provider: 'claude', model: 'claude-sonnet-4-5' }],
    ['ai.tool.requested', { tool: 'list_tasks', call_id: '1', source: 'tasks', label: 'Read your tasks' }],
    ['ai.tool.result', { tool: 'list_tasks', call_id: '1', detail: '6 due this week' }],
    ['ai.tool.requested', { tool: 'list_events', call_id: '2', source: 'calendar', label: 'Read calendar' }],
    ['ai.tool.result', { tool: 'list_events', call_id: '2' }],
    ['ai.action.proposed', { run_id: 'run1', action_id: 'act1', tool: 'calendar.create_events', title: 'Add 4 blocks to calendar', summary: '4 new blocks', items: [{ title: 'NLP lab report', detail: 'Deep work', meta: '09:00 – 10:30' }] }],
    ['ai.text.delta', { text: 'Here is the plan' }],
    ['ai.run.completed', { run_id: 'run1', input_tokens: 1200, output_tokens: 486, estimated_cost: '0.01' }],
  )
  it('builds the steps, the action card, the meta line and token usage from SSE events', async () => {
    client.aiRunEvents.mockImplementation(async () => run())
    await send('Plan my day')
    await vi.waitFor(() => expect(find('Read your tasks · Read calendar')).toBeDefined())
    const chip = find('Read your tasks · Read calendar')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    await click(chip)
    expect(host.querySelector('.actual-ai__steps')!.textContent).toContain('6 due this week')
    expect(host.querySelector('.actual-ai__action')!.textContent).toContain('Add 4 blocks to calendar')
    expect(host.querySelector('.actual-ai__action')!.textContent).toContain('NLP lab report')
    expect(host.querySelector('.actual-ai__meta')!.textContent).toBe('Claude · Sonnet 4.5 · 0.0s · 486 tokens')
    expect(host.querySelector('.actual-ai__used')!.textContent).toContain('1.7K')
  })
  it('approves a proposal through the API and shows it as approved', async () => {
    client.aiRunEvents.mockImplementation(async () => run())
    await send('Plan my day')
    client.approveAIAction.mockResolvedValue({ id: 'act1', status: 'approved' })
    await click(find('Approve'))
    expect(client.approveAIAction).toHaveBeenCalledWith('act1')
    expect(host.querySelector('.actual-ai__action')!.textContent).toContain('Approved')
    expect(find('Approve', '.actual-ai__action button')).toBeUndefined()
  })
  it('restores a pending proposal after reload and rejects it', async () => {
    client.aiConversationActions.mockResolvedValue([{ id: 'act9', tool: 'calendar.create_events', title: 'Add 2 blocks to calendar', summary: '', items: [{ title: 'Workout' }], status: 'pending' }])
    await click(find('Plan for today', '.actual-ai__conversation-main'))
    expect(client.aiConversationActions).toHaveBeenCalledWith('today')
    expect(host.querySelector('.actual-ai__action')!.textContent).toContain('Add 2 blocks to calendar')
    client.rejectAIAction.mockResolvedValue({ id: 'act9', status: 'rejected' })
    await click(find('Reject'))
    expect(client.rejectAIAction).toHaveBeenCalledWith('act9')
    expect(host.querySelector('.actual-ai__action')!.textContent).toContain('Rejected')
  })
  it('keeps the steps and the proposal on their own answer after reload', async () => {
    client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Plan my day' }, { id: 'a1', role: 'assistant', content: 'Earlier answer' },
      { id: 'u2', role: 'user', content: 'Add a quiz' }, { id: 'a2', role: 'assistant', content: 'Prepared 1 change for your approval.', steps: [{ id: 'c1', label: 'Propose a new task', detail: 'Waiting for your approval', source: 'tasks' }] }])
    client.aiConversationActions.mockResolvedValue([{ id: 'act7', tool: 'create_task', title: 'Create task', summary: 'Quiz', items: [{ title: 'Quiz' }], status: 'pending', message_id: 'a2' }])
    await click(find('Plan for today', '.actual-ai__conversation-main'))
    const answers = [...host.querySelectorAll('.actual-ai__answer')]
    expect(answers[0]!.textContent).not.toContain('Propose a new task')
    expect(answers[1]!.textContent).toContain('Propose a new task')
    expect(answers[1]!.querySelector('.actual-ai__action')!.textContent).toContain('Quiz')
  })
  it('persists thumbs up and down, toggling off with a second click', async () => {
    await click(find('Plan for today', '.actual-ai__conversation-main'))
    client.setAIMessageFeedback.mockResolvedValue({})
    await click(find('Good answer'))
    expect(client.setAIMessageFeedback).toHaveBeenLastCalledWith('a1', 'up')
    expect(find('Good answer').getAttribute('aria-pressed')).toBe('true')
    await click(find('Bad answer'))
    expect(client.setAIMessageFeedback).toHaveBeenLastCalledWith('a1', 'down')
    await click(find('Bad answer'))
    expect(client.setAIMessageFeedback).toHaveBeenLastCalledWith('a1', null)
  })
})

describe('composer', () => {
  it('attaches a file, sends its id, shows the chip on the user message and removes uploads', async () => {
    client.uploadAIAttachment.mockResolvedValue({ id: 'f1', name: 'notes.txt', size: 5, chars: 5 })
    client.deleteAIAttachment.mockResolvedValue({})
    client.aiRunEvents.mockImplementation(async () => sse(['ai.run.completed', { run_id: 'run1' }]))
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    const attach = async (name: string) => { Object.defineProperty(input, 'files', { value: [new File(['hello'], name, { type: 'text/plain' })], configurable: true }); await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) }) }
    await attach('notes.txt')
    expect(client.uploadAIAttachment).toHaveBeenCalledWith({ name: 'notes.txt', content_base64: 'aGVsbG8=' })
    expect(host.querySelector('.actual-ai__files')!.textContent).toContain('5 B')
    await click(find('Remove notes.txt'))
    expect(client.deleteAIAttachment).toHaveBeenCalledWith('f1')
    expect(host.querySelector('.actual-ai__files')).toBeNull()
    await attach('notes.txt')
    client.aiMessages.mockResolvedValue([{ id: 'u1', role: 'user', content: 'Read this', attachments: [{ name: 'notes.txt', size: 5 }] }])
    await send('Read this')
    expect(client.createAIRun.mock.calls[0]![0]).toMatchObject({ message: 'Read this', attachment_ids: ['f1'] })
    expect(host.querySelector('.actual-ai__line--user')!.textContent).toContain('notes.txt')
    expect(host.querySelector('.actual-ai__files')).toBeNull()
  })
  it('rejects unsupported and oversized files before uploading', async () => {
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'photo.png')], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(client.uploadAIAttachment).not.toHaveBeenCalled()
    expect(host.querySelector('[role=status]')!.textContent).toContain('txt, md, csv, json or pdf')
  })
  it('swaps Send for a round Stop button while a run streams', async () => {
    let release!: () => void
    client.aiRunEvents.mockImplementation(() => new Promise((resolve) => { release = () => resolve(sse(['ai.run.completed', { run_id: 'run1' }])) }))
    client.cancelAIRun.mockResolvedValue({})
    await send('Hello')
    expect(host.querySelector('[aria-label="Send message"]')).toBeNull()
    await click(find('Stop generating'))
    expect(client.cancelAIRun).toHaveBeenCalledWith('run1')
    await act(async () => release())
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send message"]')).not.toBeNull())
  })
  it('shows the keyboard hint only while the field is focused', async () => {
    expect(host.textContent).not.toContain('↵ send')
    await act(async () => host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(host.textContent).toContain('↵ send · ⇧↵ new line')
  })
})

describe('empty state and model switch', () => {
  it('shows the design empty state with suggestion cards that send at once', async () => {
    expect(host.querySelector('.actual-ai__welcome h2')!.textContent).toContain('What can I help with')
    expect(host.querySelector('.actual-ai__welcome')!.textContent).toContain('I can see tasks, calendar and notes')
    expect(host.querySelectorAll('.actual-ai__suggestions button')).toHaveLength(4)
    client.aiRunEvents.mockImplementation(async () => sse(['ai.run.completed', { run_id: 'run1' }]))
    await click(find('Review my week'))
    await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalled())
    expect(client.createAIRun.mock.calls[0]![1].idempotencyKey).toBe(client.createAIRun.mock.calls[0]![0].idempotency_key)
    expect(client.createAIRun.mock.calls[0]![0].message).toBe('Review my week')
  })
  it('inserts a "Switched to" divider when the model changes mid-chat', async () => {
    await click(find('Plan for today', '.actual-ai__conversation-main'))
    await click(host.querySelector<HTMLElement>('button[aria-label="Model"]')!)
    await click(find('Haiku 4.5', '[role=option]'))
    expect(host.querySelector('.actual-ai__divider')!.textContent).toContain('Switched to Claude · Haiku 4.5')
  })
})
