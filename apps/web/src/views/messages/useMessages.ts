import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '@aelys/shared'
import type { TelegramChatAvailability, TelegramBusinessMessage, TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { chatSendIdempotencyKey, draftOf, groupChats, mergeMessages, sendIdempotencyKey, telegramErrorNotice, REPLY_WINDOW_MS, type Chat } from '../../lib/telegramMessages'
import type { ApiStatus } from '../../types'

// Avatar palette from the design: [ink, soft background]. A chat keeps the same colour (picked from its title).
const AVATARS: readonly (readonly [string, string])[] = [['#2F6FE4', '#E4EEFD'], ['#5132D6', '#EEE8FD'], ['#0E7A57', '#DCF5EC'], ['#B8402F', '#FDE6E1'], ['#8A5A00', '#FDF1D9']]
export const colourOf = (title: string) => AVATARS[[...title].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATARS.length]
export const initialOf = (title: string) => ([...title.trim()][0] ?? '?').toUpperCase()

const pad = (n: number) => String(n).padStart(2, '0')
// Design wording: "12:40" today, "Yesterday", otherwise "Oct 29".
export function whenLabel(iso: string): string {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export function windowLabel(chat: Chat, now: number): string {
  const last = chat.target ? Date.parse(chat.target.sent_at) : NaN
  if (Number.isNaN(last)) return 'Telegram Business'
  const left = last + REPLY_WINDOW_MS - now
  if (left <= 0) return 'Reply window closed · waiting for a new message'
  const hours = Math.floor(left / 36e5)
  return hours >= 1 ? `Reply window open · ${hours}h left` : `Reply window open · ${Math.max(1, Math.floor(left / 6e4))}m left`
}
function useCompact() {
  const query = '(max-width: 700px)'
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true)
  useEffect(() => {
    const media = window.matchMedia?.(query); if (!media) return
    const update = () => setCompact(media.matches); media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return compact
}

export function useMessages(apiStatus: ApiStatus) {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [availability, setAvailability] = useState<readonly TelegramChatAvailability[]>([])
  const [replies, setReplies] = useState<Record<string, { remoteId: number; text: string } | undefined>>({})
  const [uncertain, setUncertain] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<readonly TelegramBusinessMessage[]>([])
  // Full history of the focused chat; the list endpoint only carries the newest messages.
  const [history, setHistory] = useState<readonly TelegramBusinessMessage[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tab, setTab] = useState<'need' | 'all'>('need')
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'chat'>('list')
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const sendKeys = useRef<Record<string, { signature: string; key: string }>>({})
  const compact = useCompact()
  const working = useRef(false)
  const loadGeneration = useRef(0)
  const focus = useRef<{ business_connection_id: string; chat_id: number } | null>(null)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    const focused = focus.current
    try {
      const client = getSharedApiClient()
      const [next, items, chats, detail] = await Promise.all([client.telegramStatus(), client.telegramMessages(), client.telegramChats(), focused ? client.telegramMessages(undefined, focused) : Promise.resolve<readonly TelegramBusinessMessage[]>([])])
      if (generation !== loadGeneration.current) return
      setStatus(next); setMessages(items); setHistory(detail); setAvailability(chats); setPhase('ready')
    } catch (error) { if (generation !== loadGeneration.current) return; setAvailability([]); setPhase((p) => p === 'ready' ? p : 'error'); setNotice(telegramErrorNotice(error)) }
  }, [])
  useEffect(() => {
    if (!status?.configured) return
    const refresh = () => { if (!document.hidden) { setNow(Date.now()); void load() } }
    const timer = window.setInterval(refresh, 3_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [status?.configured, load])

  const chats = useMemo(() => groupChats(mergeMessages(messages, history)), [messages, history])
  // A skipped draft is hidden locally for that message version; there is no server-side "reject".
  const skipKey = (m: TelegramBusinessMessage) => `${m.id}:${m.version}`
  const needs = (chat: Chat) => chat.needsReply && !(chat.target && skipped.has(skipKey(chat.target)))
  const draftOfLive = (chat: Chat) => { const d = draftOf(chat); return d && !skipped.has(skipKey(d)) && !editing.has(d.id) ? d : null }
  const needCount = chats.filter(needs).length
  const needle = query.trim().toLowerCase()
  const list = chats.filter((chat) => (tab === 'all' || needs(chat)) && (!needle || chat.title.toLowerCase().includes(needle)))
  const cur = chats.find((chat) => chat.id === current) ?? list[0] ?? chats[0] ?? null
  // Switching chats reloads the list and the focused chat's full history.
  focus.current = cur ? { business_connection_id: cur.businessConnectionId, chat_id: cur.chatId } : null
  const focusId = cur?.id ?? null
  useEffect(() => { void load() }, [load, apiStatus, focusId])
  const draft = cur ? draftOfLive(cur) : null
  const text = cur ? drafts[cur.id] ?? '' : ''
  const reply = cur ? replies[cur.id] : undefined
  const replyUnavailable = !!reply && !cur?.lines.some(line => line.remoteId === reply.remoteId && !line.deleted)
  const setText = (value: string) => { if (cur) setDrafts(all => ({ ...all, [cur.id]: value })) }
  const permission = cur ? availability.find(chat => chat.business_connection_id === cur.businessConnectionId && chat.chat_id === cur.chatId) : undefined
  const expiresAt = permission?.reply_window_expires_at ? Date.parse(permission.reply_window_expires_at) : NaN
  const available = () => apiStatus === 'ready' && !!status?.enabled && permission?.can_send === true && Number.isFinite(expiresAt) && expiresAt > Date.now()
  const deliveryUncertain = !!cur && uncertain[cur.id] === text.trim()
  const canSend = available() && !busy && !deliveryUncertain && !replyUnavailable
  const unavailableReason = replyUnavailable ? 'The selected message is no longer available. Cancel the reply or select another message.' : deliveryUncertain ? 'The send result is unknown. Check the Telegram chat before composing another message.' : apiStatus !== 'ready' ? 'Connect to the API before sending.' : !permission ? 'Refresh the chat to check sending permissions.' : !status?.enabled ? 'The Telegram connection is paused.' : Number.isFinite(expiresAt) && expiresAt <= now ? 'The Telegram reply window (24 hours) has expired. Wait for a new message from the other person.' : !permission.can_send ? telegramErrorNotice(new ApiError(409, permission.send_disabled_code ?? 'TELEGRAM_REPLY_DENIED', '')) : ''
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()))
    const update = () => setNow(Date.now())
    document.addEventListener('visibilitychange', update)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', update) }
  }, [expiresAt])


  const run = async (work: () => Promise<void>) => {
    if (working.current) return
    working.current = true
    setBusy(true); setNotice('')
    try { await work() } catch (error) { setNotice(telegramErrorNotice(error)) } finally { working.current = false; setBusy(false) }
  }
  const replace = (item: TelegramBusinessMessage) => { loadGeneration.current += 1; setMessages((all) => all.some(m => m.id === item.id) ? all.map((m) => m.id === item.id ? item : m) : [...all, item]) }
  const nextNeeding = (from: Chat) => list.find((chat) => chat.id !== from.id && needs(chat))?.id
  const afterReply = (from: Chat) => { if (compact) setView('list'); else { const next = nextNeeding(from); if (next) setCurrent(next) } }

  const sendTo = (target: TelegramBusinessMessage, body: string, from: Chat, advance: boolean) => {
    if (!body.trim() || target.deleted_at || !available() || working.current) return
    if (!advance) setCurrent(from.id)
    void run(async () => {
      const key = sendIdempotencyKey(sendKeys.current, target, body)
      replace(await getSharedApiClient().sendTelegramMessage(target.id, { version: target.version, text: body }, { idempotencyKey: key }))
      delete sendKeys.current[target.id]
      if (!advance) setDrafts(all => all[from.id]?.trim() === body.trim() ? { ...all, [from.id]: '' } : all)
      else afterReply(from)
    })
  }
  const sendDraft = () => { if (cur && draft) sendTo(draft, draft.draft_text ?? '', cur, true) }
  const sendOwn = () => {
    if (!cur || !text.trim() || !available() || working.current || deliveryUncertain || replyUnavailable || text.length > 4096) return
    if (!reply && cur.target && editing.has(cur.target.id) && cur.target.draft_status === 'ready') { sendTo(cur.target, text.trim(), cur, false); return }
    const from = cur, body = text.trim(), replyTarget = reply?.remoteId
    setCurrent(from.id)
    void run(async () => {
      const key = chatSendIdempotencyKey(sendKeys.current, from.id, body, replyTarget)
      try {
        const outgoing = await getSharedApiClient().sendTelegramChatMessage({ business_connection_id: from.businessConnectionId, chat_id: from.chatId, text: body, ...(replyTarget === undefined ? {} : { reply_to_message_id: replyTarget }) }, { idempotencyKey: key })
        replace(outgoing)
        delete sendKeys.current[from.id]
        setReplies(all => all[from.id]?.remoteId === replyTarget ? { ...all, [from.id]: undefined } : all)
        setDrafts(all => all[from.id]?.trim() === body ? { ...all, [from.id]: '' } : all)
      } catch (error) {
        if (error instanceof ApiError && ['TELEGRAM_DELIVERY_UNKNOWN', 'TELEGRAM_SEND_IN_PROGRESS'].includes(error.code)) setUncertain(all => ({ ...all, [from.id]: body }))
        await load(); throw error
      }
    })
  }
  const edit = () => { if (draft) { setText(draft.draft_text ?? ''); setEditing((s) => new Set(s).add(draft.id)) } }
  const rewrite = (target: TelegramBusinessMessage | null) => {
    if (!target || target.deleted_at) return
    void run(async () => { replace(await getSharedApiClient().draftTelegramMessage(target.id, { version: target.version })); setEditing((s) => { const n = new Set(s); n.delete(target.id); return n }) })
  }
  const skip = () => { if (cur?.target) { const target = cur.target; setSkipped((s) => new Set(s).add(skipKey(target))); afterReply(cur) } }

  // ⌘↵ sends the draft; J / K step through chats (not while typing).
  const keys = useRef({ sendDraft, sendOwn, step: (_: number) => {} })
  keys.current = { sendDraft, sendOwn, step: (delta: number) => { if (!list.length) return; const i = Math.max(0, list.findIndex((c) => c.id === cur?.id)); const next = list[Math.min(list.length - 1, Math.max(0, i + delta))]; setCurrent(next.id) } }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (e.target instanceof Element && e.target.closest('.msg__composer')) keys.current.sendOwn(); else keys.current.sendDraft(); return }
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'j' || e.key === 'J') keys.current.step(1)
      if (e.key === 'k' || e.key === 'K') keys.current.step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showList = !compact || view === 'list', showChat = !compact || view === 'chat'
  const ink = cur ? colourOf(cur.title) : AVATARS[0]
  const generating = cur?.target?.draft_status === 'generating'
  const failed = cur?.target?.draft_status === 'failed'
  return { status, setReplies, text, draft, phase, setPhase, load, tab, setTab, query, setQuery, cur, setCurrent, setView, list, skip, edit, busy, notice, now, compact, chats, needs, draftOfLive, needCount, reply, available, setText, deliveryUncertain, canSend, unavailableReason, sendDraft, sendOwn, rewrite, showList, showChat, ink, generating, failed }
}
