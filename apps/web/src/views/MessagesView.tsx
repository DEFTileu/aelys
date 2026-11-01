import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TelegramBusinessMessage, TelegramStatus } from '@aelys/shared'
import { ArrowUp, Check, ChevronLeft, RotateCcw, Search, Send, Sparkles } from '../icons'
import { PageSkeleton } from '../components/PageSkeleton'
import { getSharedApiClient } from '../lib/api'
import { navigate } from '../lib/router'
import { draftOf, groupChats, sendIdempotencyKey, telegramErrorNotice, REPLY_WINDOW_MS, type Chat } from '../lib/telegramMessages'
import type { ApiStatus } from '../types'
import './desktop/page-tokens.css'
import './messages.css'

// Avatar palette from the design: [ink, soft background]. A chat keeps the same colour (picked from its title).
const AVATARS: readonly (readonly [string, string])[] = [['#2F6FE4', '#E4EEFD'], ['#5132D6', '#EEE8FD'], ['#0E7A57', '#DCF5EC'], ['#B8402F', '#FDE6E1'], ['#8A5A00', '#FDF1D9']]
const colourOf = (title: string) => AVATARS[[...title].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATARS.length]
const initialOf = (title: string) => ([...title.trim()][0] ?? '?').toUpperCase()

const pad = (n: number) => String(n).padStart(2, '0')
// Design wording: "12:40" today, "Yesterday", otherwise "Oct 29".
function whenLabel(iso: string): string {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function windowLabel(chat: Chat, now: number): string {
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

export function MessagesView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [messages, setMessages] = useState<readonly TelegramBusinessMessage[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tab, setTab] = useState<'need' | 'all'>('need')
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'chat'>('list')
  const [text, setText] = useState('')
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const sendKeys = useRef<Record<string, { signature: string; key: string }>>({})
  const compact = useCompact()

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
  const afterReply = (from: Chat) => { if (compact) setView('list'); else { const next = nextNeeding(from); if (next) setCurrent(next) } }

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

  if (phase !== 'ready') return <div className="msg-page"><PageSkeleton kind="split" label="messages" phase={phase === 'error' ? 'error' : 'loading'} compact={compact} onRetry={() => { setPhase('loading'); void load() }} /></div>
  if (!status?.configured) return <div className="msg-page"><div className="msg msg--solo"><div className="msg__empty"><Send size={28} /><div className="msg__empty-title">Telegram is not connected</div><div>Connect a Telegram bot in Settings to see your chats here.</div><button type="button" className="msg__btn msg__btn--primary" onClick={() => navigate('/settings')}>Open Settings</button></div></div></div>

  const showList = !compact || view === 'list', showChat = !compact || view === 'chat'
  const ink = cur ? colourOf(cur.title) : AVATARS[0]
  const generating = cur?.target?.draft_status === 'generating'
  const failed = cur?.target?.draft_status === 'failed'

  return <div className="msg-page">
    {notice && <p className="msg__notice" role="status">{notice}</p>}
    <div className={`msg${compact ? ' msg--compact' : ''}`}>
      {showList && <div className="msg__list">
        <div className="msg__list-head">
          <div className="msg__tabs" role="tablist">{([['need', `Needs reply · ${needCount}`], ['all', 'All']] as const).map(([value, label]) => <span key={value} role="tab" tabIndex={0} aria-selected={tab === value} className={tab === value ? 'is-on' : undefined} onClick={() => setTab(value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(value) } }}>{label}</span>)}</div>
          <label className="msg__search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" /></label>
        </div>
        <div className="msg__rows" role="listbox" aria-label="Chats">
          {list.map((chat) => { const [c, soft] = colourOf(chat.title); const on = !compact && chat.id === cur?.id; const unread = needs(chat) ? chat.waiting : 0
            return <div key={chat.id} role="option" tabIndex={0} aria-selected={on} className={`msg__row${on ? ' is-on' : ''}`} onClick={() => { setCurrent(chat.id); setView('chat') }} onKeyDown={(e) => { if (e.key === 'Enter') { setCurrent(chat.id); setView('chat') } }}>
              <span className="msg__avatar msg__avatar--44" style={{ color: c, background: soft }}>{initialOf(chat.title)}</span>
              <div className="msg__row-body">
                <div className="msg__row-top"><span className="msg__row-name">{chat.title}</span><span className="msg__row-time">{whenLabel(chat.lastAt)}</span></div>
                <div className="msg__row-bottom"><span className="msg__row-last">{(chat.lastMine ? 'You: ' : '') + chat.lastText}</span>
                  {!!draftOfLive(chat) && <span className="msg__chip"><Sparkles size={11} />Draft</span>}
                  {unread > 0 && <span className="msg__badge">{unread}</span>}</div>
              </div>
            </div> })}
          {list.length === 0 && (tab === 'need' || chats.length > 0
            ? <div className="msg__empty"><Check size={28} className="msg__empty-ok" /><div className="msg__empty-title">All caught up</div><div className="msg__empty-sub">{tab === 'need' ? 'No chats need a reply' : 'No chats match your search'}</div></div>
            : <div className="msg__empty"><Send size={28} /><div className="msg__empty-title">No messages yet</div><div className="msg__empty-sub">Messages from Telegram Business appear here</div></div>)}
        </div>
      </div>}

      {showChat && <div className="msg__chat">
        {cur ? <>
          <div className="msg__chat-head">
            {compact && <span className="msg__back" role="button" tabIndex={0} aria-label="Back" onClick={() => setView('list')} onKeyDown={(e) => { if (e.key === 'Enter') setView('list') }}><ChevronLeft size={20} /></span>}
            <span className="msg__avatar msg__avatar--40" style={{ color: ink[0], background: ink[1] }}>{initialOf(cur.title)}</span>
            <div className="msg__chat-title"><div className="msg__chat-name">{cur.title}</div><div className="msg__chat-sub">{windowLabel(cur, now)}</div></div>
          </div>
          <div className="msg__lines">
            {cur.lines.map((line) => <div key={line.id} className={`msg__line${line.mine ? ' is-out' : ''}`}>
              <div className={`msg__bubble${line.deleted ? ' is-deleted' : ''}`}>{line.text}</div>
              <div className="msg__meta">{line.byAelys ? <><Sparkles size={11} />Sent by Aelys ·<span>{whenLabel(line.at)}</span></> : whenLabel(line.at)}</div>
            </div>)}
          </div>
          <div className="msg__bottom">
            {cur.target && !cur.target.deleted_at && (draft || generating || failed || (cur.needsReply && cur.target.draft_status !== 'ready')) && <div className="msg__draft">
              <div className="msg__draft-title"><Sparkles size={12} />Aelys draft</div>
              <div className="msg__draft-text">{draft ? draft.draft_text : generating ? 'Aelys is writing a reply…' : failed ? 'Aelys could not write a draft. Try again.' : cur.target.draft_status === 'handoff' ? (cur.target.owner_note || 'Aelys left this one for you.') : 'No draft yet.'}</div>
              {!draft && cur.target.owner_note && cur.target.draft_status !== 'handoff' && <div className="msg__draft-note">{cur.target.owner_note}</div>}
              <div className="msg__draft-actions">
                {draft && <button type="button" className="msg__btn msg__btn--primary" disabled={busy} onClick={sendDraft}><Send size={13} />Send</button>}
                {draft && <button type="button" className="msg__btn" onClick={edit}>Edit</button>}
                <button type="button" className={draft ? 'msg__btn' : 'msg__btn msg__btn--primary'} aria-label={draft ? 'Rewrite' : 'Draft a reply'} disabled={busy || generating} onClick={() => rewrite(cur.target)}><RotateCcw size={13} />{compact ? '' : draft ? 'Rewrite' : 'Draft a reply'}</button>
                <button type="button" className="msg__btn msg__btn--ghost" onClick={skip}>Skip</button>
                {!compact && draft && <><span className="msg__grow" /><span className="msg__hint">⌘↵ send · J / K next chat</span></>}
              </div>
            </div>}
            <div className="msg__composer">
              <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) sendOwn() }} placeholder="Write a reply…" aria-label="Write a reply" />
              <span role="button" tabIndex={0} aria-label="Send" aria-disabled={!text.trim()} className={`msg__send${text.trim() ? ' is-on' : ''}`} onClick={sendOwn} onKeyDown={(e) => { if (e.key === 'Enter') sendOwn() }}><ArrowUp size={14} /></span>
            </div>
          </div>
        </> : <div className="msg__empty msg__empty--chat"><Send size={28} /><div className="msg__empty-title">No messages yet</div><div className="msg__empty-sub">Messages from Telegram Business appear here</div></div>}
      </div>}
    </div>
  </div>
}
