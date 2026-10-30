import type { NativeOperation, NativeInvoke } from './nativeTransport'
import { createNativeTransport, NATIVE_SESSION_EXPIRED_EVENT } from './nativeTransport'

type NativeTransport = ReturnType<typeof createNativeTransport>

function nativeAIEventResponse(transport: NativeTransport, origin: string, id: string, signal?: AbortSignal | null): Promise<Response> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  const requestId = crypto.randomUUID()
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array>
  let opened = false
  let finished = false
  let closeAfterOpen = false
  let resolveReady: (response: Response) => void
  let rejectReady: (reason: unknown) => void
  const ready = new Promise<Response>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const cleanup = () => signal?.removeEventListener('abort', abort)
  const closeRemote = () => { void transport.closeAIEvents(origin, requestId).catch(() => {}) }
  const fail = (error: unknown, readerCancelled = false) => {
    if (finished) return
    const code = error instanceof Error ? error.message : error
    if ((code === 'SIGN_IN_REQUIRED' || code === 'UNAUTHORIZED') && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(NATIVE_SESSION_EXPIRED_EVENT, { detail: { origin } }))
    finished = true
    cleanup()
    if (!readerCancelled) controller.error(error instanceof Error ? error : new Error(String(error)))
    rejectReady(error)
  }
  const abortStream = (readerCancelled = false) => {
    fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'), readerCancelled)
    if (opened) closeRemote()
    else closeAfterOpen = true
  }
  const abort = () => abortStream()
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() { abortStream(true) },
  })
  signal?.addEventListener('abort', abort, { once: true })
  // Invoke success and Channel messages can reach JS in different turns. Only
  // the ordered Channel end/error message closes the readable stream.
  void transport.aiEvents(origin, id, requestId, (message) => {
    if (message.type === 'opened') {
      opened = true
      if (closeAfterOpen) { closeRemote(); return }
      if (!finished) resolveReady(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
      return
    }
    if (finished) return
    if (message.type === 'error') { fail(new Error(message.code)); return }
    if (message.type === 'end') { finished = true; cleanup(); controller.close(); return }
    const event = message.event
    const eventId = event.id === null ? '' : `id: ${event.id}\n`
    controller.enqueue(encoder.encode(`${eventId}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`))
  }).catch(fail)
  return ready
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function bodyValue(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string' || !body) return {}
  try {
    const value: unknown = JSON.parse(body)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function operationFor(url: URL, init?: RequestInit): NativeOperation | undefined {
  const method = (init?.method ?? 'GET').toUpperCase()
  const path = url.pathname
  if (method === 'GET' && path === '/api/v1/me') return { type: 'me' }
  if (method === 'GET' && path === '/api/v1/projects') return { type: 'projects' }
  if (method === 'POST' && path === '/api/v1/projects') return { type: 'project_create', project: bodyValue(init?.body) }
  const projectMatch = path.match(/^\/api\/v1\/projects\/([A-Za-z0-9_-]+)$/)
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1])
    if (method === 'DELETE') return { type: 'project_delete', id }
    if (method === 'PATCH') {
      const body = bodyValue(init?.body)
      const version = body.version
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
      const { version: _version, ...project } = body
      return { type: 'project_patch', id, version, project }
    }
  }
  if (method === 'GET' && path === '/api/v1/notes') return { type: 'notes' }
  if (method === 'POST' && path === '/api/v1/notes') return { type: 'note_create', note: bodyValue(init?.body) }
  const noteMatch = path.match(/^\/api\/v1\/notes\/([A-Za-z0-9_-]+)$/)
  if (noteMatch) {
    const id = decodeURIComponent(noteMatch[1])
    if (method === 'DELETE') return { type: 'note_delete', id }
    if (method === 'PATCH') {
      const version = Number(url.searchParams.get('version'))
      if (!Number.isInteger(version) || version < 1) return undefined
      return { type: 'note_patch', id, version, note: bodyValue(init?.body) }
    }
  }
  if (method === 'GET' && path === '/api/v1/calendar/occurrences') {
    const startsAt = url.searchParams.get('starts_at')
    const endsAt = url.searchParams.get('ends_at')
    return startsAt && endsAt ? { type: 'calendar_occurrences', starts_at: startsAt, ends_at: endsAt } : undefined
  }
  if (method === 'GET' && path === '/api/v1/calendar/events') return { type: 'calendar_events' }
  if (method === 'POST' && path === '/api/v1/calendar/reminders/dispatch') return { type: 'calendar_reminder_dispatch' }
  if (method === 'POST' && path === '/api/v1/calendar/events') return { type: 'calendar_event_create', event: bodyValue(init?.body) }
  const calendarMatch = path.match(/^\/api\/v1\/calendar\/events\/([A-Za-z0-9_-]+)$/)
  if (calendarMatch) {
    const id = decodeURIComponent(calendarMatch[1])
    if (method === 'DELETE') {
      const version = Number(url.searchParams.get('version'))
      return Number.isInteger(version) && version > 0 ? { type: 'calendar_event_delete', id, version } : undefined
    }
    if (method === 'PATCH') {
      const body = bodyValue(init?.body)
      const version = body.version
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
      const { version: _version, ...event } = body
      return { type: 'calendar_event_patch', id, version, event }
    }
  }
  const remindersMatch = path.match(/^\/api\/v1\/calendar\/events\/([A-Za-z0-9_-]+)\/reminders(?:\/([A-Za-z0-9_-]+))?$/)
  if (remindersMatch) {
    const eventId = decodeURIComponent(remindersMatch[1])
    const reminderId = remindersMatch[2] ? decodeURIComponent(remindersMatch[2]) : undefined
    if (method === 'GET' && !reminderId) return { type: 'calendar_reminders', event_id: eventId }
    if (method === 'POST' && !reminderId) return { type: 'calendar_reminder_create', event_id: eventId, reminder: bodyValue(init?.body) }
    if (method === 'DELETE' && reminderId) {
      const version = Number(url.searchParams.get('version'))
      return Number.isInteger(version) && version > 0 ? { type: 'calendar_reminder_delete', event_id: eventId, reminder_id: reminderId, version } : undefined
    }
  }
  if (method === 'GET' && path === '/api/v1/finance/transactions') return { type: 'finance_transactions' }
  if (method === 'GET' && path === '/api/v1/finance/accounts') return { type: 'finance_accounts' }
  if (method === 'GET' && path === '/api/v1/finance/categories') return { type: 'finance_categories' }
  if (method === 'GET' && path === '/api/v1/finance/budgets') return { type: 'finance_budgets' }
  if (method === 'GET' && path === '/api/v1/finance/summary') return { type: 'finance_summary' }
  if (method === 'POST' && path === '/api/v1/finance/accounts') return { type: 'finance_account_create', account: bodyValue(init?.body) }
  if (method === 'POST' && path === '/api/v1/finance/categories') return { type: 'finance_category_create', category: bodyValue(init?.body) }
  if (method === 'POST' && path === '/api/v1/finance/transactions') return { type: 'finance_transaction_create', transaction: bodyValue(init?.body) }
  if (method === 'POST' && path === '/api/v1/finance/budgets') return { type: 'finance_budget_create', budget: bodyValue(init?.body) }
  if (method === 'POST' && path === '/api/v1/finance/transfers') return { type: 'finance_transfer_create', transfer: bodyValue(init?.body) }
  if (method === 'GET' && path === '/api/v1/focus/sessions') return { type: 'focus_sessions' }
  if (method === 'POST' && path === '/api/v1/focus/sessions') {
    const key = new Headers(init?.headers).get('Idempotency-Key') ?? undefined
    return { type: 'focus_start', focus: bodyValue(init?.body), ...(key ? { idempotency_key: key } : {}) }
  }
  const focusMatch = path.match(/^\/api\/v1\/focus\/sessions\/([A-Za-z0-9_-]+)\/stop$/)
  if (focusMatch && method === 'POST') {
    const version = Number(url.searchParams.get('version'))
    return Number.isInteger(version) && version > 0 ? { type: 'focus_stop', id: decodeURIComponent(focusMatch[1]), version } : undefined
  }
  if (method === 'GET' && path === '/api/v1/mail/messages') return { type: 'mail_messages' }
  if (method === 'GET' && path === '/api/v1/mail/accounts') return { type: 'mail_accounts' }
  if (method === 'GET' && path === '/api/v1/mail/gmail/status') return { type: 'gmail_status' }
  if (method === 'GET' && path === '/api/v1/ai/providers') return { type: 'ai_providers' }
  if (method === 'GET' && path === '/api/v1/ai/conversations') return { type: 'ai_conversations' }
  if (method === 'POST' && path === '/api/v1/ai/conversations') return { type: 'ai_conversation_create', conversation: bodyValue(init?.body) }
  const aiMessagesMatch = path.match(/^\/api\/v1\/ai\/conversations\/([A-Za-z0-9_-]+)\/messages$/)
  if (method === 'GET' && aiMessagesMatch) return { type: 'ai_messages', conversation_id: decodeURIComponent(aiMessagesMatch[1]) }
  if (method === 'POST' && aiMessagesMatch) return { type: 'ai_message_create', conversation_id: decodeURIComponent(aiMessagesMatch[1]), message: bodyValue(init?.body) }
  if (method === 'POST' && path === '/api/v1/ai/runs') return { type: 'ai_run_create', run: bodyValue(init?.body) }
  const aiRunMatch = path.match(/^\/api\/v1\/ai\/runs\/([A-Za-z0-9_-]+)(?:\/(events|cancel))?$/)
  if (aiRunMatch) {
    const id = decodeURIComponent(aiRunMatch[1])
    if (aiRunMatch[2] === 'events' && method === 'GET') return { type: 'ai_run_events', id }
    if (aiRunMatch[2] === 'cancel' && method === 'POST') return { type: 'ai_run_cancel', id }
    if (!aiRunMatch[2] && method === 'GET') return { type: 'ai_run_get', id }
  }
  if (method === 'GET' && path === '/api/v1/mail/drafts') return { type: 'mail_drafts' }
  if (method === 'POST' && path === '/api/v1/mail/drafts') return { type: 'mail_draft_create', draft: bodyValue(init?.body) }
  const draftMatch = path.match(/^\/api\/v1\/mail\/drafts\/([A-Za-z0-9_-]+)$/)
  if (draftMatch) {
    const id = decodeURIComponent(draftMatch[1])
    if (method === 'DELETE') {
      const version = Number(url.searchParams.get('version'))
      return Number.isInteger(version) && version > 0 ? { type: 'mail_draft_delete', id, version } : undefined
    }
    if (method === 'PATCH') {
      const body = bodyValue(init?.body)
      const version = body.version
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
      const { version: _version, ...draft } = body
      return { type: 'mail_draft_patch', id, version, draft }
    }
  }
  if (method === 'GET' && path === '/api/v1/activity') return { type: 'activity' }
  if (method === 'GET' && path === '/api/v1/notifications') return { type: 'notifications' }
  const notificationMatch = path.match(/^\/api\/v1\/notifications\/([A-Za-z0-9_-]+)\/read$/)
  if (method === 'POST' && notificationMatch) return { type: 'notification_read', id: decodeURIComponent(notificationMatch[1]) }
  if (method === 'GET' && path === '/api/v1/tasks') {
    const projectId = url.searchParams.get('project_id') ?? undefined
    return projectId ? { type: 'tasks', project_id: projectId } : { type: 'tasks' }
  }
  if (path === '/api/v1/tasks' && method === 'POST') return { type: 'task_create', task: bodyValue(init?.body) }
  const match = path.match(/^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)$/)
  if (!match) return undefined
  const id = decodeURIComponent(match[1])
  if (method === 'DELETE') return { type: 'task_delete', id }
  if (method === 'PATCH') {
    const body = bodyValue(init?.body)
    const version = body.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
    const { version: _version, ...task } = body
    return { type: 'task_patch', id, version, task }
  }
  return undefined
}

/**
 * Adapt only the Rust operation allowlist to the shared client's fetch shape.
 * Unsupported routes return a typed error; they never fall back to browser fetch.
 */
export function createNativeFetch(transport: NativeTransport, origin: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), `${origin}/`)
    const operation = operationFor(url, init)
    if (!operation) return jsonResponse({ detail: { code: 'NATIVE_OPERATION_UNSUPPORTED', message: 'This module is not available in the native pilot.' } }, 501)
    try {
      if (operation.type === 'ai_run_events') return await nativeAIEventResponse(transport, origin, operation.id, init?.signal)
      const value = await transport.operation<unknown>(origin, operation)
      return jsonResponse(value)
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError')
      const code = typeof error === 'string' ? error : 'NATIVE_TRANSPORT_ERROR'
      const expired = code === 'UNAUTHORIZED' || code === 'SIGN_IN_REQUIRED'
      if (expired && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(NATIVE_SESSION_EXPIRED_EVENT, { detail: { origin } }))
      return jsonResponse({ detail: { code, message: expired ? 'Sign in again.' : 'Native operation failed.' } }, expired ? 401 : 502)
    }
  }
}

export function createNativeFetchFromInvoke(invoke: NativeInvoke, origin: string): typeof fetch {
  return createNativeFetch(createNativeTransport(invoke), origin)
}
