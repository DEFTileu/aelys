import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TelegramBusinessMessage, TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { draftOf, groupChats, sendIdempotencyKey, telegramErrorNotice, REPLY_WINDOW_MS, type Chat } from '../../lib/telegramMessages'
import type { ApiStatus } from '../../types'

// Avatar palette from the design: [ink, soft background]. A chat keeps the same colour (picked from its title).
const AVATARS: readonly (readonly [string, string])[] = [['#2F6FE4', '#E4EEFD'], ['#5132D6', '#EEE8FD'], ['#0E7A57', '#DCF5EC'], ['#B8402F', '#FDE6E1'], ['#8A5A00', '#FDF1D9']]
export const colourOf = (title: string) => AVATARS[[...title].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATARS.length]
export const initialOf = (title: string) => ([...title.trim()][0] ?? '?').toUpperCase()
export const AVATAR_DEFAULT = AVATARS[0]

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

/** All Messages state and actions; the desktop and mobile screens only render it. */
export function useMessages(apiStatus: ApiStatus) {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [messages, setMessages] = useState<readonly TelegramBusinessMessage[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tab, setTab] = useState<'need' | 'all'>('need')
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  // Mobile shows one conversation at a time; desktop ignores this and keeps both panes.
  const [view, setView] = useState<'list' | 'chat'>('list')
  const [text, setText] = useState('')
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const sendKeys = useRef<Record<string, { signature: string; key: string }>>({})

  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const [next, items] = await Promise.all([client.telegramStatus(), client.telegramMessages()])
      setStatus(next); setMessages(items); setPhase('ready')
    } catch (error) { setPhase((p) => p === 'ready' ? p : 'error'); setNotice(telegramErrorNotice(error)) }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])
  useEffect(() => {
    if (!status?.configured) return
    const timer = window.setInterval(() => { setNow(Date.now()); void load() }, 10_000)
    return () => window.clearInterval(timer)
  }, [status?.configured, load])

  const chats = useMemo(() => groupChats(messages), [messages])
  // A skipped draft is hidden locally for that message version; there is no server-side "reject".
  const skipKey = (m: TelegramBusinessMessage) => `${m.id}:${m.version}`
  const needs = (chat: Chat) => chat.needsReply && !(chat.target && skipped.has(skipKey(chat.target)))
  const draftOfLive = (chat: Chat) => { const d = draftOf(chat); return d && !skipped.has(skipKey(d)) && !editing.has(d.id) ? d : null }
  const needCount = chats.filter(needs).length
  const needle = query.trim().toLowerCase()
  const list = chats.filter((chat) => (tab === 'all' || needs(chat)) && (!needle || chat.title.toLowerCase().includes(needle)))
  const cur = chats.find((chat) => chat.id === current) ?? list[0] ?? chats[0] ?? null
  const draft = cur ? draftOfLive(cur) : null

  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setNotice('')
    try { await work() } catch (error) { setNotice(telegramErrorNotice(error)) } finally { setBusy(false) }
  }
  const replace = (item: TelegramBusinessMessage) => setMessages((all) => all.map((m) => m.id === item.id ? item : m))
  const nextNeeding = (from: Chat) => list.find((chat) => chat.id !== from.id && needs(chat))?.id
  const afterReply = (from: Chat) => { setView('list'); const next = nextNeeding(from); if (next) setCurrent(next) }
  const openChat = (id: string) => { setCurrent(id); setView('chat') }

  const sendTo = (target: TelegramBusinessMessage, body: string, from: Chat, advance: boolean) => {
    if (!body.trim() || target.deleted_at) return
    void run(async () => {
      const key = sendIdempotencyKey(sendKeys.current, target, body)
      replace(await getSharedApiClient().sendTelegramMessage(target.id, { version: target.version, text: body }, { idempotencyKey: key }))
      delete sendKeys.current[target.id]
      if (!advance) setText('')
      else afterReply(from)
    })
  }
  const sendDraft = () => { if (cur && draft) sendTo(draft, draft.draft_text ?? '', cur, true) }
  const sendOwn = () => { if (cur?.target) sendTo(cur.target, text.trim(), cur, false) }
  const edit = () => { if (draft) { setText(draft.draft_text ?? ''); setEditing((s) => new Set(s).add(draft.id)) } }
  const rewrite = (target: TelegramBusinessMessage | null) => {
    if (!target || target.deleted_at) return
    void run(async () => { replace(await getSharedApiClient().draftTelegramMessage(target.id, { version: target.version })); setEditing((s) => { const n = new Set(s); n.delete(target.id); return n }) })
  }
  const skip = () => { if (cur?.target) { const target = cur.target; setSkipped((s) => new Set(s).add(skipKey(target))); afterReply(cur) } }

  // ⌘↵ sends the draft; J / K step through chats (not while typing).
  const keys = useRef({ sendDraft, step: (_: number) => {} })
  keys.current = { sendDraft, step: (delta: number) => { if (!list.length) return; const i = Math.max(0, list.findIndex((c) => c.id === cur?.id)); const next = list[Math.min(list.length - 1, Math.max(0, i + delta))]; setCurrent(next.id) } }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); keys.current.sendDraft(); return }
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'j' || e.key === 'J') keys.current.step(1)
      if (e.key === 'k' || e.key === 'K') keys.current.step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const retry = () => { setPhase('loading'); void load() }
  return { apiStatus, status, phase, retry, tab, setTab, query, setQuery, view, setView, openChat, text, setText, busy, notice, now, chats, needs, draftOfLive, needCount, list, cur, draft, sendDraft, sendOwn, edit, rewrite, skip }
}

export type MessagesState = ReturnType<typeof useMessages>
