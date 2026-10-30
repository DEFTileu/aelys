/** Public Tauri invoke signature, injected by the desktop integration. */
export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export type NativeOperation =
  | { type: 'me' }
  | { type: 'projects' }
  | { type: 'project_create'; project: Record<string, unknown> }
  | { type: 'project_patch'; id: string; version: number; project: Record<string, unknown> }
  | { type: 'project_delete'; id: string }
  | { type: 'tasks'; project_id?: string }
  | { type: 'notes' }
  | { type: 'note_create'; note: Record<string, unknown> }
  | { type: 'note_patch'; id: string; version: number; note: Record<string, unknown> }
  | { type: 'note_delete'; id: string }
  | { type: 'calendar_occurrences'; starts_at: string; ends_at: string }
  | { type: 'calendar_events' }
  | { type: 'calendar_event_create'; event: Record<string, unknown> }
  | { type: 'calendar_event_patch'; id: string; version: number; event: Record<string, unknown> }
  | { type: 'calendar_event_delete'; id: string; version: number }
  | { type: 'calendar_reminders'; event_id: string }
  | { type: 'calendar_reminder_create'; event_id: string; reminder: Record<string, unknown> }
  | { type: 'calendar_reminder_delete'; event_id: string; reminder_id: string; version: number }
  | { type: 'calendar_reminder_dispatch' }
  | { type: 'finance_transactions' }
  | { type: 'finance_accounts' }
  | { type: 'finance_categories' }
  | { type: 'finance_budgets' }
  | { type: 'finance_summary' }
  | { type: 'finance_account_create'; account: Record<string, unknown> }
  | { type: 'finance_category_create'; category: Record<string, unknown> }
  | { type: 'finance_transaction_create'; transaction: Record<string, unknown> }
  | { type: 'finance_budget_create'; budget: Record<string, unknown> }
  | { type: 'finance_transfer_create'; transfer: Record<string, unknown> }
  | { type: 'focus_sessions' }
  | { type: 'focus_start'; focus: Record<string, unknown>; idempotency_key?: string }
  | { type: 'focus_stop'; id: string; version: number }
  | { type: 'mail_messages' }
  | { type: 'mail_accounts' }
  | { type: 'gmail_status' }
  | { type: 'ai_providers' }
  | { type: 'ai_conversations' }
  | { type: 'ai_messages'; conversation_id: string }
  | { type: 'ai_conversation_create'; conversation: Record<string, unknown> }
  | { type: 'ai_message_create'; conversation_id: string; message: Record<string, unknown> }
  | { type: 'ai_run_create'; run: Record<string, unknown> }
  | { type: 'ai_run_get'; id: string }
  | { type: 'ai_run_cancel'; id: string }
  | { type: 'ai_run_events'; id: string }
  | { type: 'mail_drafts' }
  | { type: 'mail_draft_create'; draft: Record<string, unknown> }
  | { type: 'mail_draft_patch'; id: string; version: number; draft: Record<string, unknown> }
  | { type: 'mail_draft_delete'; id: string; version: number }
  | { type: 'activity' }
  | { type: 'notifications' }
  | { type: 'notification_read'; id: string }
  | { type: 'task_create'; task: Record<string, unknown> }
  | { type: 'task_patch'; id: string; version: number; task: Record<string, unknown> }
  | { type: 'task_delete'; id: string }

export type NativeStatus = {
  signed_in: boolean
  owner_id: string | null
  device_id: string | null
  can_resume: boolean | null
  initialized: boolean | null
  biometric_locked?: boolean
}

export type BiometricStatus = { supported: boolean; available: boolean; enabled: boolean }
export const NATIVE_SESSION_EXPIRED_EVENT = 'aelys:native-session-expired'
export type KeychainScope = 'session' | 'touch_id_policy'

export const KEYCHAIN_ACCESS_NOTICE = 'Нужен доступ к связке ключей.'

export function isKeychainAccessRequired(error: unknown): boolean {
  return error === 'KEYCHAIN_ACCESS_REQUIRED' || (error instanceof Error && error.message === 'KEYCHAIN_ACCESS_REQUIRED')
}

export type NativeAIEvent = { id: string | null; event: string; data: Record<string, unknown> }
export type NativeAIStreamMessage =
  | { type: 'opened' }
  | { type: 'event'; event: NativeAIEvent }
  | { type: 'end' }
  | { type: 'error'; code: string }
export type NativeChannelFactory = (receive: (message: NativeAIStreamMessage) => void) => unknown

/** Detection only: IPC must use the official Tauri invoke API, never this global. */
export function isNativeHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && Boolean(window.__TAURI_INTERNALS__)
}

/** Resolve the backend origin used by Rust. Relative browser defaults mean the
 * local backend in the packaged desktop app; absolute settings stay explicit. */
export function nativeBackendOrigin(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/$/, '')
  if (/^https?:\/\//i.test(normalized)) return normalized.replace(/\/api\/v1$/, '')
  if (normalized.startsWith('/')) return 'http://127.0.0.1:8000'
  // Preserve malformed/unsupported absolute values so Rust rejects them rather
  // than silently switching a user's configured server back to localhost.
  return normalized.replace(/\/api\/v1$/, '')
}

export function createNativeTransport(invoke: NativeInvoke, makeChannel?: NativeChannelFactory) {
  return {
    status: (origin: string) => invoke<NativeStatus>('native_status', { origin }),
    authorizeKeychain: (origin: string, scope: KeychainScope) => invoke<boolean>('native_keychain_authorize', { origin, scope }),
    biometricStatus: (origin: string) => invoke<BiometricStatus>('native_biometric_status', { origin }),
    setBiometric: (origin: string, enabled: boolean) => invoke<BiometricStatus>('native_biometric_set', { origin, enabled }),
    health: (origin: string) => invoke<boolean>('native_health', { origin }),
    login: (origin: string, email: string, password: string, bootstrap = false) =>
      invoke<NativeStatus>('native_login', { origin, email, password, bootstrap }),
    resume: (origin: string) => invoke<NativeStatus>('native_resume', { origin }),
    logout: (origin: string) => invoke<NativeStatus>('native_logout', { origin }),
    operation: <T>(origin: string, operation: NativeOperation) => invoke<T>('native_operation', { origin, operation }),
    aiEvents: async (origin: string, id: string, requestId: string, receive: (message: NativeAIStreamMessage) => void) => {
      if (!makeChannel) throw new Error('NATIVE_STREAM_UNAVAILABLE')
      const onEvent = makeChannel(receive)
      await invoke<void>('native_ai_events', { origin, id, requestId, onEvent })
    },
    closeAIEvents: (origin: string, requestId: string) => invoke<void>('native_ai_events_close', { origin, requestId }),
  }
}

export async function loadNativeTransport() {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  return createNativeTransport(invoke as NativeInvoke, (receive) => new Channel<NativeAIStreamMessage>(receive))
}
