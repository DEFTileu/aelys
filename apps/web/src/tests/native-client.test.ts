import { describe, expect, it, vi } from 'vitest'
import { createNativeFetchFromInvoke } from '../lib/nativeClient'
import type { NativeInvoke } from '../lib/nativeTransport'

describe('native shared-client bridge', () => {
  it('reports native expiry as 401 without retrying or claiming a backend outage', async () => {
    const invoke = vi.fn(async () => { throw 'SIGN_IN_REQUIRED' }) as NativeInvoke
    const listener = vi.fn()
    window.addEventListener('aelys:native-session-expired', listener)
    const response = await createNativeFetchFromInvoke(invoke, 'http://127.0.0.1:8000')('http://127.0.0.1:8000/api/v1/tasks')
    expect(response.status).toBe(401)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('aelys:native-session-expired', listener)
  })
  it('routes only the typed Me, Projects and Tasks operations', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => ({
      operation: args?.operation,
    })) as NativeInvoke
    const fetcher = createNativeFetchFromInvoke(invoke, 'http://127.0.0.1:8000')
    const response = await fetcher('http://127.0.0.1:8000/api/v1/tasks?project_id=project-1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ operation: { type: 'tasks', project_id: 'project-1' } })
    expect(invoke).toHaveBeenCalledWith('native_operation', {
      origin: 'http://127.0.0.1:8000',
      operation: { type: 'tasks', project_id: 'project-1' },
    })
  })

  it('passes task writes with an explicit version and never forwards HTTP headers', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'task-1', version: 2 }))
    const invoke = invokeMock as unknown as NativeInvoke
    const fetcher = createNativeFetchFromInvoke(invoke, 'http://127.0.0.1:8000')
    const response = await fetcher('http://127.0.0.1:8000/api/v1/tasks/task-1', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer browser-must-not-cross-ipc' },
      body: JSON.stringify({ title: 'Updated', description: '', status: 'todo', priority: 0, version: 1 }),
    })
    expect(response.status).toBe(200)
    expect(invokeMock.mock.calls[0][1]).toEqual({
      origin: 'http://127.0.0.1:8000',
      operation: { type: 'task_patch', id: 'task-1', version: 1, task: { title: 'Updated', description: '', status: 'todo', priority: 0 } },
    })
  })

  it('routes Home read sources through distinct typed operations', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => [])
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    for (const [path, operation] of [
      ['/api/v1/notes', { type: 'notes' }],
      ['/api/v1/notifications', { type: 'notifications' }],
      ['/api/v1/calendar/occurrences?starts_at=2026-01-01T00%3A00%3A00Z&ends_at=2026-01-02T00%3A00%3A00Z', { type: 'calendar_occurrences', starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-01-02T00:00:00Z' }],
      ['/api/v1/calendar/events', { type: 'calendar_events' }],
      ['/api/v1/finance/transactions', { type: 'finance_transactions' }],
      ['/api/v1/finance/accounts', { type: 'finance_accounts' }],
      ['/api/v1/finance/categories', { type: 'finance_categories' }],
      ['/api/v1/finance/budgets', { type: 'finance_budgets' }],
      ['/api/v1/finance/summary', { type: 'finance_summary' }],
      ['/api/v1/focus/sessions', { type: 'focus_sessions' }],
      ['/api/v1/mail/messages', { type: 'mail_messages' }],
      ['/api/v1/activity', { type: 'activity' }],
    ] as const) {
      expect((await fetcher(`http://127.0.0.1:8000${path}`)).status).toBe(200)
      expect(invokeMock.mock.calls.at(-1)?.[1]).toEqual({ origin: 'http://127.0.0.1:8000', operation })
    }
  })

  it('routes project lifecycle and notification actions through typed IPC', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'project-1', version: 2 }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Plan', description: '' }) })
    await fetcher('http://127.0.0.1:8000/api/v1/projects/project-1', { method: 'PATCH', body: JSON.stringify({ name: 'Updated', version: 1 }) })
    await fetcher('http://127.0.0.1:8000/api/v1/notifications/notification-1/read', { method: 'POST' })
    await fetcher('http://127.0.0.1:8000/api/v1/calendar/reminders/dispatch', { method: 'POST' })
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'project_create', project: { name: 'Plan', description: '' } } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'project_patch', id: 'project-1', version: 1, project: { name: 'Updated' } } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'notification_read', id: 'notification-1' } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'calendar_reminder_dispatch' } },
    ])
  })

  it('routes decimal finance writes without coercing amounts to numbers', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'transaction-1' }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/finance/transactions', {
      method: 'POST',
      body: JSON.stringify({ account_id: 'account-1', category_id: null, amount: '1250.00', currency: 'KZT', type: 'expense', occurred_at: '2026-01-01T00:00:00Z', notes: '', idempotency_key: 'posting-1' }),
    })
    expect(invokeMock.mock.calls[0]?.[1]).toEqual({
      origin: 'http://127.0.0.1:8000',
      operation: { type: 'finance_transaction_create', transaction: { account_id: 'account-1', category_id: null, amount: '1250.00', currency: 'KZT', type: 'expense', occurred_at: '2026-01-01T00:00:00Z', notes: '', idempotency_key: 'posting-1' } },
    })
  })

  it('routes Finance budget and transfer writes as typed decimal payloads', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'finance-1' }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/finance/budgets', { method: 'POST', body: JSON.stringify({ category_id: null, currency: 'KZT', period_start: '2026-01-01T00:00:00Z', period_end: '2026-02-01T00:00:00Z', limit_amount: '50000.00' }) })
    await fetcher('http://127.0.0.1:8000/api/v1/finance/transfers', { method: 'POST', body: JSON.stringify({ from_account_id: 'account-a', to_account_id: 'account-b', amount: '5000.00', currency: 'KZT', occurred_at: '2026-01-01T00:00:00Z', notes: '', idempotency_key: 'transfer-1' }) })
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'finance_budget_create', budget: { category_id: null, currency: 'KZT', period_start: '2026-01-01T00:00:00Z', period_end: '2026-02-01T00:00:00Z', limit_amount: '50000.00' } } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'finance_transfer_create', transfer: { from_account_id: 'account-a', to_account_id: 'account-b', amount: '5000.00', currency: 'KZT', occurred_at: '2026-01-01T00:00:00Z', notes: '', idempotency_key: 'transfer-1' } } },
    ])
  })

  it('keeps calendar event updates and deletes versioned', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'event-1', version: 2 }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    const event = { title: 'Event', description: '', starts_at: '2026-01-01T10:00:00Z', ends_at: '2026-01-01T11:00:00Z', timezone: 'UTC', all_day: false, project_id: null, linked_task_id: null, rrule: null, reminder_at: null }
    await fetcher('http://127.0.0.1:8000/api/v1/calendar/events/event-1', { method: 'PATCH', body: JSON.stringify({ ...event, version: 1 }) })
    expect(invokeMock.mock.calls[0]?.[1]).toEqual({ origin: 'http://127.0.0.1:8000', operation: { type: 'calendar_event_patch', id: 'event-1', version: 1, event } })
    await fetcher('http://127.0.0.1:8000/api/v1/calendar/events/event-1?version=2', { method: 'DELETE' })
    expect(invokeMock.mock.calls[1]?.[1]).toEqual({ origin: 'http://127.0.0.1:8000', operation: { type: 'calendar_event_delete', id: 'event-1', version: 2 } })
  })

  it('keeps calendar reminders bound to the event and versioned on cancel', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'reminder-1', version: 1 }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/calendar/events/event-1/reminders', {
      method: 'POST', body: JSON.stringify({ event_id: 'event-1', notify_at: '2026-01-01T09:00:00Z', channel: 'in_app', idempotency_key: 'reminder-1' }),
    })
    await fetcher('http://127.0.0.1:8000/api/v1/calendar/events/event-1/reminders/reminder-1?version=1', { method: 'DELETE' })
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'calendar_reminder_create', event_id: 'event-1', reminder: { event_id: 'event-1', notify_at: '2026-01-01T09:00:00Z', channel: 'in_app', idempotency_key: 'reminder-1' } } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'calendar_reminder_delete', event_id: 'event-1', reminder_id: 'reminder-1', version: 1 } },
    ])
  })

  it('preserves focus idempotency and version on native lifecycle calls', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'focus-1', version: 2 }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/focus/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'focus-1' },
      body: JSON.stringify({ task_id: null, project_id: null, started_at: '2026-01-01T10:00:00Z', mode: 'pomodoro' }),
    })
    await fetcher('http://127.0.0.1:8000/api/v1/focus/sessions/focus-1/stop?version=1', { method: 'POST' })
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'focus_start', focus: { task_id: null, project_id: null, started_at: '2026-01-01T10:00:00Z', mode: 'pomodoro' }, idempotency_key: 'focus-1' } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'focus_stop', id: 'focus-1', version: 1 } },
    ])
  })

  it('keeps local mail drafts versioned and separate from Gmail credentials', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'draft-1', version: 2 }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    const draft = { account_id: null, thread_id: null, recipients: [], subject: 'Draft', content: 'Body' }
    await fetcher('http://127.0.0.1:8000/api/v1/mail/drafts/draft-1', { method: 'PATCH', body: JSON.stringify({ ...draft, version: 1 }) })
    expect(invokeMock.mock.calls[0]?.[1]).toEqual({ origin: 'http://127.0.0.1:8000', operation: { type: 'mail_draft_patch', id: 'draft-1', version: 1, draft } })
  })

  it('keeps Mail account metadata and Gmail status read-only in native IPC', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => [])
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/mail/accounts')
    await fetcher('http://127.0.0.1:8000/api/v1/mail/gmail/status')
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'mail_accounts' } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'gmail_status' } },
    ])
  })

  it('reads AI provider metadata without exposing provider secrets', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => [])
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/ai/providers')
    await fetcher('http://127.0.0.1:8000/api/v1/ai/conversations/conversation-1/messages')
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'ai_providers' } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'ai_messages', conversation_id: 'conversation-1' } },
    ])
  })

  it('routes AI conversation and message creation through typed IPC', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'ai-1', version: 1 }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/ai/conversations', {
      method: 'POST', body: JSON.stringify({ title: 'Plan', project_id: null, tool_scope: { scopes: ['tasks.write'] } }),
    })
    await fetcher('http://127.0.0.1:8000/api/v1/ai/conversations/conversation-1/messages', {
      method: 'POST', body: JSON.stringify({ role: 'user', content: 'Hello', source_refs: [] }),
    })
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'ai_conversation_create', conversation: { title: 'Plan', project_id: null, tool_scope: { scopes: ['tasks.write'] } } } },
      { origin: 'http://127.0.0.1:8000', operation: { type: 'ai_message_create', conversation_id: 'conversation-1', message: { role: 'user', content: 'Hello', source_refs: [] } } },
    ])
  })

  it('routes AI run creation through the typed operation', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'run-1', status: 'queued' }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/ai/runs', { method: 'POST', body: JSON.stringify({ conversation_id: 'conversation-1', message: 'Hello', routing: {}, tool_scope: {}, idempotency_key: 'run-1' }) })
    expect(invokeMock.mock.calls.map((call) => call[1])).toEqual([
      { origin: 'http://127.0.0.1:8000', operation: { type: 'ai_run_create', run: { conversation_id: 'conversation-1', message: 'Hello', routing: {}, tool_scope: {}, idempotency_key: 'run-1' } } },
    ])
  })

  it('keeps native note writes versioned and typed', async () => {
    const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => ({ id: 'note-1', version: 2, title: 'Updated', markdown_body: '', parent_id: null, project_id: null }))
    const fetcher = createNativeFetchFromInvoke(invokeMock as unknown as NativeInvoke, 'http://127.0.0.1:8000')
    await fetcher('http://127.0.0.1:8000/api/v1/notes/note-1?version=1', {
      method: 'PATCH', body: JSON.stringify({ title: 'Updated', markdown_body: '', parent_id: null, project_id: null }),
    })
    expect(invokeMock.mock.calls[0]?.[1]).toEqual({
      origin: 'http://127.0.0.1:8000',
      operation: { type: 'note_patch', id: 'note-1', version: 1, note: { title: 'Updated', markdown_body: '', parent_id: null, project_id: null } },
    })
  })

  it('fails closed for unsupported modules and transport errors', async () => {
    const unsupported = createNativeFetchFromInvoke(vi.fn() as NativeInvoke, 'http://127.0.0.1:8000')
    const response = await unsupported('http://127.0.0.1:8000/api/v1/mail/gmail/connect')
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ detail: { code: 'NATIVE_OPERATION_UNSUPPORTED' } })

    const invoke = vi.fn(async () => { throw 'NATIVE_TRANSPORT_ERROR' }) as NativeInvoke
    const failed = createNativeFetchFromInvoke(invoke, 'http://127.0.0.1:8000')
    expect((await failed('http://127.0.0.1:8000/api/v1/me')).status).toBe(502)
  })
})
