import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiView } from '../views/AiView'
import { MailView } from '../views/MailView'
import { ProviderSettings } from '../views/ProviderSettings'
import { FinanceView } from '../views/FinanceView'
import { TimerView } from '../views/TimerView'
import { NotificationCenter } from '../components/NotificationCenter'
import { consumeSse } from '../lib/sse'

const client = vi.hoisted(() => ({ aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), createAIConversation: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn(), createAIProvider: vi.fn(), setAIProviderSecret: vi.fn(), updateAIProvider: vi.fn(), mailMessages: vi.fn(), mailDrafts: vi.fn(), createMailDraft: vi.fn(), updateMailDraft: vi.fn(), mailAccounts: vi.fn(), gmailStatus: vi.fn(), financeAccounts: vi.fn(), financeCategories: vi.fn(), financeBudgets: vi.fn(), financeTransactions: vi.fn(), financeSummary: vi.fn(), createFinanceAccount: vi.fn(), createFinanceCategory: vi.fn(), createFinanceBudget: vi.fn(), createFinanceTransaction: vi.fn(), createFinanceTransfer: vi.fn(), focusSessions: vi.fn(), tasks: vi.fn(), projects: vi.fn(), startFocusSession: vi.fn(), stopFocusSession: vi.fn(), notifications: vi.fn(), dispatchCalendarReminders: vi.fn(), markNotificationRead: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client, getAccessToken: () => 'test-session' }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
async function render(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(element)) }
async function fill(label: string, value: string) {
  const input = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find((el) => el.getAttribute('aria-label') === label || el.closest('label')?.textContent?.includes(label))!
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)!.click()) }
async function submit() { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }

beforeEach(() => { vi.resetAllMocks(); client.mailAccounts.mockResolvedValue([]); client.gmailStatus.mockResolvedValue({ configured: false }); client.financeCategories.mockResolvedValue([]); client.financeBudgets.mockResolvedValue([]) })
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })

describe('connected workspaces', () => {
  it('stores a provider key through the secret endpoint and clears the password field', async () => {
    client.aiProviders.mockResolvedValue([]); client.createAIProvider.mockResolvedValue({ id: 'provider-1' })
    await render(<ProviderSettings />)
    await fill('Model ID', 'example-model'); await fill('API key', 'private-key-for-test')
    await submit()
    expect(client.createAIProvider).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), { queueOnOffline: false })
    expect(client.setAIProviderSecret).toHaveBeenCalledWith('provider-1', { api_key: 'private-key-for-test' })
    expect(client.updateAIProvider).toHaveBeenCalledWith('provider-1', expect.objectContaining({ enabled: true }))
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    expect(host.textContent).not.toContain('private-key-for-test')
  })

  it('does not label an interrupted AI stream as completed', async () => {
    client.aiProviders.mockResolvedValue([{ id: 'p1', kind: 'claude', enabled: true, has_secret: true, model_policy: { default_model: 'model' } }])
    client.aiConversations.mockResolvedValue([]); client.createAIConversation.mockResolvedValue({ id: 'c1', title: 'Chat' })
    client.createAIRun.mockResolvedValue({ id: 'r1' }); client.aiMessages.mockResolvedValue([])
    client.aiRunEvents.mockResolvedValue(new Response('event: ai.text.delta\ndata: {"text":"Partial reply"}\n\n'))
    await render(<AiView apiStatus="ready" />)
    await fill('Message Aelys', 'Hello'); await submit()
    expect(host.textContent).toContain('Partial reply')
    expect(host.textContent).toContain('before the provider confirmed completion')
    expect(client.createAIRun).toHaveBeenCalledWith(expect.objectContaining({ routing: { provider_id: 'p1', provider: 'claude', model: 'model' } }), { queueOnOffline: false })
  })

  it('renders imported mail as text and creates an editable reply draft', async () => {
    client.mailMessages.mockResolvedValue([{ id: 'm1', sender: 'Person <person@example.test>', recipients: ['owner@example.test'], subject: 'Question', body: '<script>bad()</script>', received_at: '2026-10-29T12:00:00Z', thread_id: 'thread-1' }])
    client.mailDrafts.mockResolvedValue([]); client.createMailDraft.mockResolvedValue({ id: 'd1', version: 1 })
    await render(<MailView apiStatus="ready" />)
    expect(host.textContent).toContain('<script>bad()</script>'); expect(host.querySelector('script')).toBeNull()
    await fill('Reply draft', 'My reply'); await submit()
    expect(client.createMailDraft).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['person@example.test'], subject: 'Re: Question', content: 'My reply', thread_id: 'thread-1' }), { queueOnOffline: false })
    expect(host.textContent).toContain('Draft saved.')
  })

  it('keeps reply text per message and updates only the draft created by this reply', async () => {
    const message = (id: string, sender: string) => ({ id, sender, recipients: ['owner@example.test'], subject: id, body: 'Body', received_at: '2026-10-29T12:00:00Z', thread_id: 'shared-thread' })
    client.mailMessages.mockResolvedValue([message('m1', 'first@example.test'), message('m2', 'second@example.test')])
    client.mailDrafts.mockResolvedValue([{ id: 'existing', version: 9, recipients: [], subject: 'Another draft', content: 'Keep me', thread_id: 'shared-thread' }])
    client.createMailDraft.mockResolvedValue({ id: 'new-reply', version: 1, content: 'First reply' })
    client.updateMailDraft.mockResolvedValue({ id: 'new-reply', version: 2, content: 'Updated reply' })
    await render(<MailView apiStatus="ready" />)
    await fill('Reply draft', 'First reply'); await submit()
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.actual-mail-row')[1]!.click())
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Reply draft"]')!.value).toBe('')
    await fill('Reply draft', 'Second reply')
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.actual-mail-row')[0]!.click())
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Reply draft"]')!.value).toBe('First reply')
    await fill('Reply draft', 'Updated reply'); await submit()
    expect(client.createMailDraft).toHaveBeenCalledTimes(1)
    expect(client.updateMailDraft).toHaveBeenCalledWith('new-reply', expect.objectContaining({ version: 1, content: 'Updated reply' }), { queueOnOffline: false })
  })

  it('creates finance records using decimal strings and exposes transfers', async () => {
    client.financeAccounts.mockResolvedValue([{ id: 'a1', name: 'Cash', currency: 'KZT', type: 'cash' }]); client.financeTransactions.mockResolvedValue([]); client.financeSummary.mockResolvedValue({ total: '0.00', count: 0 })
    await render(<FinanceView apiStatus="ready" />)
    expect(host.querySelector('form.actual-record')).not.toBeNull(); await fill('Amount (decimal)', '1250.50'); await submit()
    expect(client.createFinanceTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: '1250.50' }), expect.objectContaining({ queueOnOffline: false, idempotencyKey: expect.any(String) }))
  })

  it('creates the selected category and a budget with explicit period', async () => {
    client.financeAccounts.mockResolvedValue([]); client.financeTransactions.mockResolvedValue([]); client.financeSummary.mockResolvedValue({ count: 0, total: '0', currencies: [] }); client.financeCategories.mockResolvedValue([{ id: 'food', name: 'Food', kind: 'expense' }])
    await render(<FinanceView apiStatus="ready" />)
    await click('Add category'); await fill('Name', 'Travel'); await submit()
    expect(client.createFinanceCategory).toHaveBeenCalledWith({ name: 'Travel', kind: 'expense' }, expect.objectContaining({ idempotencyKey: expect.any(String) }))
    await click('Add budget'); await fill('Limit (decimal)', '50000.0001'); await fill('Period start', '2026-11-01'); await fill('Period end', '2026-12-01')
    const category = host.querySelector<HTMLSelectElement>('select')!
    await act(async () => { category.value = 'food'; category.dispatchEvent(new Event('change', { bubbles: true })) })
    await submit()
    expect(client.createFinanceBudget).toHaveBeenCalledWith(expect.objectContaining({ category_id: 'food', limit_amount: '50000.0001', period_start: new Date('2026-11-01T00:00:00').toISOString(), period_end: new Date('2026-12-01T00:00:00').toISOString() }), expect.objectContaining({ queueOnOffline: false }))
  })

  it('submits a transfer with the same stable operation key in header and body', async () => {
    client.financeAccounts.mockResolvedValue([{ id: 'a1', name: 'Cash', currency: 'KZT', type: 'cash' }, { id: 'a2', name: 'Savings', currency: 'KZT', type: 'cash' }]); client.financeTransactions.mockResolvedValue([]); client.financeSummary.mockResolvedValue({ count: 0, total: '0', currencies: [] })
    await render(<FinanceView apiStatus="ready" />)
    await click('Transfer between accounts'); await fill('Amount (decimal)', '12.3401'); await submit()
    const [body, options] = client.createFinanceTransfer.mock.calls[0]!
    expect(body).toMatchObject({ from_account_id: 'a1', to_account_id: 'a2', currency: 'KZT', amount: '12.3401', idempotency_key: options.idempotencyKey })
  })

  it('filters actual finance history by type and account without changing amounts', async () => {
    client.financeAccounts.mockResolvedValue([{ id: 'a1', name: 'Cash', currency: 'KZT', type: 'cash' }, { id: 'a2', name: 'Bank', currency: 'KZT', type: 'cash' }])
    client.financeSummary.mockResolvedValue({ count: 2, total: '0', currencies: [] })
    client.financeTransactions.mockResolvedValue([
      { id: 't1', account_id: 'a1', type: 'expense', amount: '1234567890123456.0001', currency: 'KZT', notes: 'Groceries', occurred_at: '2026-10-29T12:00:00Z' },
      { id: 't2', account_id: 'a2', type: 'income', amount: '12.3400', currency: 'KZT', notes: 'Salary', occurred_at: '2026-10-29T12:00:00Z' },
    ])
    await render(<FinanceView apiStatus="ready" />)
    expect(host.textContent).toContain('1234567890123456.0001')
    await act(async () => host.querySelector<HTMLButtonElement>('.actual-filter button:nth-child(3)')!.click())
    expect(host.textContent).toContain('Salary'); expect(host.textContent).not.toContain('Groceries')
    const filter = host.querySelector<HTMLSelectElement>('select[aria-label="Filter by account"]')!
    await act(async () => { filter.value = 'a1'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('No transactions for these filters.')
    await act(async () => host.querySelector<HTMLButtonElement>('.actual-filter button:nth-child(2)')!.click())
    expect(host.textContent).toContain('1234567890123456.0001'); expect(host.textContent).not.toContain('Salary')
  })

  it('starts and stops a persisted focus session through the API', async () => {
    const active = { id: 's1', version: 1, started_at: new Date(Date.now() - 30_000).toISOString(), mode: 'pomodoro', status: 'active', elapsed_seconds: 30 }
    client.focusSessions.mockResolvedValue([]); client.tasks.mockResolvedValue([]); client.projects.mockResolvedValue([])
    client.startFocusSession.mockImplementation(async () => { client.focusSessions.mockResolvedValue([active]); return active })
    client.stopFocusSession.mockImplementation(async () => { const stopped = { ...active, status: 'completed', elapsed_seconds: 31 }; client.focusSessions.mockResolvedValue([stopped]); return stopped })
    await render(<TimerView apiStatus="ready" />); await click('Start focus')
    expect(client.startFocusSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'pomodoro' }), expect.objectContaining({ queueOnOffline: false, idempotencyKey: expect.any(String) }))
    expect(host.textContent).toContain('Total focus: 00:00:30')
    await click('Stop focus')
    expect(client.stopFocusSession).toHaveBeenCalledWith('s1', expect.objectContaining({ query: { version: 1 }, queueOnOffline: false }))
    expect(host.textContent).toContain('Total focus: 00:00:31')
  })
  it('keeps offline ledger writes disabled while showing cached data', async () => {
    client.financeAccounts.mockResolvedValue([]); client.financeTransactions.mockResolvedValue([]); client.financeSummary.mockResolvedValue({ total: '0', count: 0, currencies: [] })
    await render(<FinanceView apiStatus="offline" />)
    await click('Add account')
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"], form button:not([type])')?.disabled).toBe(true)
    expect(host.textContent).toContain('OFFLINE_WRITE_UNAVAILABLE')
    expect(client.createFinanceAccount).not.toHaveBeenCalled()
  })

  it('shows delivered notifications and marks them read through the API', async () => {
    const reminder = { id: 'notice-1', title: 'Meeting reminder', body: 'Scheduled calendar reminder', read_at: null }
    client.dispatchCalendarReminders.mockResolvedValue({ delivered: 1 }); client.notifications.mockResolvedValue([reminder]); client.markNotificationRead.mockResolvedValue({ ...reminder, read_at: new Date().toISOString() })
    await render(<NotificationCenter apiStatus="ready" route="/calendar" />)
    expect(client.dispatchCalendarReminders).toHaveBeenCalled()
    await act(async () => host.querySelector('button')!.click())
    expect(host.textContent).toContain('Meeting reminder')
    await click('Mark as read')
    expect(client.markNotificationRead).toHaveBeenCalledWith('notice-1', { queueOnOffline: false })
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Notifications')
  })

})

it('decodes SSE CRLF and Unicode split between network chunks', async () => {
  const encoded = new TextEncoder().encode('event: ai.text.delta\r\ndata: {"text":"Привет"}\r\n\r\nevent: ai.run.completed\r\ndata: {}\r\n\r\n')
  const stream = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const events: unknown[] = []
  await consumeSse(new Response(stream), (name, data) => events.push([name, data]))
  expect(events).toEqual([['ai.text.delta', { text: 'Привет' }], ['ai.run.completed', {}]])
})
