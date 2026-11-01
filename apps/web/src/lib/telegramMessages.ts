import { ApiError, type TelegramBusinessMessage } from '@aelys/shared'

// API messages and provider text can contain secrets; only display a constrained error code.
const NOTICES: Record<string, string> = {
  TELEGRAM_MESSAGE_UNAVAILABLE: 'Replies are available only for incoming messages. Select a message from the other person; the connection must be active.',
  TELEGRAM_REPLY_DENIED: 'The bot cannot reply in this chat. Check the connection and reply permissions in Telegram Business settings.',
  TELEGRAM_REPLY_WINDOW_EXPIRED: 'The Telegram reply window (24 hours) has expired. Wait for a new message from the other person.',
  TELEGRAM_PAUSED: 'The connection is paused. Resume it before drafting or sending a reply.',
  TELEGRAM_RATE_LIMITED: 'Telegram is limiting requests. Wait before trying again.',
  TELEGRAM_SEND_IN_PROGRESS: 'This message is already being sent. Check Telegram before trying again.',
  IDEMPOTENCY_CONFLICT: 'This request belongs to a different message. Refresh the chat.',
  NOT_FOUND: 'This chat is not available. Refresh the Telegram connection.',
  ALREADY_SENT: 'A reply has already been sent to this message. Select a new incoming message.',
  TELEGRAM_PROVIDER_REQUIRED: 'Choose an AI provider with a saved API key for automatic replies.',
  TELEGRAM_BINDING_REQUIRED: 'Link the owner and connect the bot to Telegram Business.',
  TELEGRAM_INSTRUCTIONS_REQUIRED: 'Enter assistant instructions before turning on automatic replies.',
  TELEGRAM_WEBHOOK_CONFLICT: 'The bot has a webhook configured. Remove it in Telegram before connecting.',
  TELEGRAM_TOKEN_INVALID: 'The bot token is invalid. Check the token in BotFather.',
  TELEGRAM_VERSION_CONFLICT: 'Settings changed. Refresh and try again.',
  TELEGRAM_DELIVERY_UNKNOWN: 'The send result is unknown. Check the Telegram chat before sending again.',
  PROVIDER_REQUIRED: 'Choose an AI provider with a saved API key for automatic replies.',
  BINDING_REQUIRED: 'Link the owner and connect the bot to Telegram Business.',
  INSTRUCTIONS_REQUIRED: 'Enter assistant instructions before turning on automatic replies.',
  WEBHOOK_CONFLICT: 'The bot has a webhook configured. Remove it in Telegram before connecting.',
  TOKEN_INVALID: 'The bot token is invalid. Check the token in BotFather.',
  VERSION_CONFLICT: 'Settings changed. Refresh and try again.',
  DELIVERY_UNKNOWN: 'The send result is unknown. Check the Telegram chat before sending again.',
}

export function telegramErrorNotice(error: unknown): string {
  if (error instanceof ApiError && Object.hasOwn(NOTICES, error.code)) return NOTICES[error.code]
  return 'The request failed. Check your connection and try again.'
}

/** One idempotency key per (message version, text): a retry of the same send reuses it, an edited send gets a new one. */
export function sendIdempotencyKey(store: Record<string, { signature: string; key: string }>, message: TelegramBusinessMessage, text: string): string {
  const signature = JSON.stringify([message.version, text])
  let entry = store[message.id]
  if (!entry || entry.signature !== signature) { entry = { signature, key: globalThis.crypto.randomUUID() }; store[message.id] = entry }
  return entry.key
}

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

export type ChatLine = { id: string; mine: boolean; text: string; at: string; byAelys: boolean; deleted: boolean }
export type Chat = {
  id: string; businessConnectionId: string; chatId: number; title: string; messages: readonly TelegramBusinessMessage[]; lines: readonly ChatLine[]
  /** Newest incoming message: the one replies are sent against. */
  target: TelegramBusinessMessage | null
  waiting: number; needsReply: boolean; lastText: string; lastAt: string; lastMine: boolean
}

const timeOf = (m: TelegramBusinessMessage) => Date.parse(m.sent_at) || 0
const DONE = new Set(['sent', 'sending', 'unknown', 'no_reply'])

/** Groups Telegram Business messages per chat (connection + chat id) with the conversation lines the Messages app shows. */
export function groupChats(messages: readonly TelegramBusinessMessage[]): Chat[] {
  const byChat = new Map<string, TelegramBusinessMessage[]>()
  for (const m of messages) {
    const key = `${m.business_connection_id}:${m.chat_id}`
    const list = byChat.get(key); if (list) list.push(m); else byChat.set(key, [m])
  }
  const chats: Chat[] = []
  for (const [id, raw] of byChat) {
    const sorted = [...raw].sort((a, b) => timeOf(a) - timeOf(b) || a.telegram_message_id - b.telegram_message_id)
    const lines: ChatLine[] = []
    for (const m of sorted) {
      if (m.deleted_at) { lines.push({ id: m.id, mine: m.direction !== 'inbound', text: 'Message deleted', at: m.sent_at, byAelys: false, deleted: true }); continue }
      lines.push({ id: m.id, mine: m.direction !== 'inbound', text: m.text || 'Message without text', at: m.sent_at, byAelys: false, deleted: false })
      // A sent draft is the reply Aelys wrote; show it unless the owner's echo of the same text is already in the chat.
      if (m.direction === 'inbound' && m.draft_status === 'sent' && m.draft_text && !sorted.some((o) => o.direction !== 'inbound' && o.text === m.draft_text && timeOf(o) >= timeOf(m))) lines.push({ id: `${m.id}:reply`, mine: true, text: m.draft_text, at: m.sent_at, byAelys: true, deleted: false })
    }
    const live = sorted.filter((m) => !m.deleted_at)
    const incoming = live.filter((m) => m.direction === 'inbound')
    const target = incoming[incoming.length - 1] ?? null
    const lastOut = [...live].reverse().find((m) => m.direction !== 'inbound')
    const waitingMessages = incoming.filter((m) => !DONE.has(m.draft_status) && (!lastOut || timeOf(m) > timeOf(lastOut)))
    const last = lines[lines.length - 1]
    const newest = live[live.length - 1]
    chats.push({
      id, businessConnectionId: sorted[0].business_connection_id, chatId: sorted[0].chat_id, title: sorted.find((m) => m.chat_title)?.chat_title || 'Unknown chat', messages: sorted, lines, target,
      waiting: waitingMessages.length, needsReply: !!newest && newest.direction === 'inbound' && !DONE.has(newest.draft_status),
      lastText: last ? last.text : '', lastAt: last ? last.at : '', lastMine: !!last?.mine,
    })
  }
  return chats.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0))
}

/** The ready draft on the chat's newest incoming message, if there is one to review. */
export function draftOf(chat: Chat): TelegramBusinessMessage | null {
  const t = chat.target
  return t && chat.needsReply && t.draft_status === 'ready' && t.draft_text?.trim() ? t : null
}

/** A successful send clears its entry; intentional identical messages then get new keys. */
export function chatSendIdempotencyKey(store: Record<string, { signature: string; key: string }>, chatId: string, text: string): string {
  let entry = store[chatId]
  if (!entry || entry.signature !== text) { entry = { signature: text, key: globalThis.crypto.randomUUID() }; store[chatId] = entry }
  return entry.key
}
