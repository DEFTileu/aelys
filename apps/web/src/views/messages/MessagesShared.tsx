import type { ReactElement } from 'react'
import { Check, Search, Send, Sparkles, RotateCcw, ArrowUp } from '../../icons'
import { PageSkeleton } from '../../components/PageSkeleton'
import { navigate } from '../../lib/router'
import type { Chat } from '../../lib/telegramMessages'
import '../../views/desktop/page-tokens.css'
import '../messages.css'
import { whenLabel, type MessagesState } from './useMessages'

/** Loading, error and not-connected screens, shared by both layouts. */
export function messagesFallback(t: MessagesState, className: string): ReactElement | null {
  if (t.phase !== 'ready') return <div className={className}><PageSkeleton kind="split" label="messages" phase={t.phase === 'error' ? 'error' : 'loading'} onRetry={t.retry} /></div>
  if (!t.status?.configured) return <div className={className}><div className="msg msg--solo"><div className="msg__empty"><Send size={28} /><div className="msg__empty-title">Telegram is not connected</div><div>Connect a Telegram bot in Settings to see your chats here.</div><button type="button" className="msg__btn msg__btn--primary" onClick={() => navigate('/settings')}>Open Settings</button></div></div></div>
  return null
}

export function ChatTabs({ t }: { t: MessagesState }) {
  return <div className="msg__tabs" role="tablist">{([['need', `Needs reply · ${t.needCount}`], ['all', 'All']] as const).map(([value, label]) => <span key={value} role="tab" tabIndex={0} aria-selected={t.tab === value} className={t.tab === value ? 'is-on' : undefined} onClick={() => t.setTab(value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.setTab(value) } }}>{label}</span>)}</div>
}

export function ChatSearch({ t }: { t: MessagesState }) {
  return <label className="msg__search"><Search size={14} /><input value={t.query} onChange={(e) => t.setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" /></label>
}

export function ListEmpty({ t }: { t: MessagesState }) {
  if (t.list.length > 0) return null
  return t.tab === 'need' || t.chats.length > 0
    ? <div className="msg__empty"><Check size={28} className="msg__empty-ok" /><div className="msg__empty-title">All caught up</div><div className="msg__empty-sub">{t.tab === 'need' ? 'No chats need a reply' : 'No chats match your search'}</div></div>
    : <div className="msg__empty"><Send size={28} /><div className="msg__empty-title">No messages yet</div><div className="msg__empty-sub">Messages from Telegram Business appear here</div></div>
}

export function ChatLines({ cur }: { cur: Chat }) {
  return <div className="msg__lines">
    {cur.lines.map((line) => <div key={line.id} className={`msg__line${line.mine ? ' is-out' : ''}`}>
      <div className={`msg__bubble${line.deleted ? ' is-deleted' : ''}`}>{line.text}</div>
      <div className="msg__meta">{line.byAelys ? <><Sparkles size={11} />Sent by Aelys ·<span>{whenLabel(line.at)}</span></> : whenLabel(line.at)}</div>
    </div>)}
  </div>
}

export function DraftCard({ t, cur, hint = false }: { t: MessagesState; cur: Chat; hint?: boolean }) {
  const { draft, busy } = t
  const generating = cur.target?.draft_status === 'generating'
  const failed = cur.target?.draft_status === 'failed'
  if (!cur.target || cur.target.deleted_at || !(draft || generating || failed || (cur.needsReply && cur.target.draft_status !== 'ready'))) return null
  return <div className="msg__draft">
    <div className="msg__draft-title"><Sparkles size={12} />Aelys draft</div>
    <div className="msg__draft-text">{draft ? draft.draft_text : generating ? 'Aelys is writing a reply…' : failed ? 'Aelys could not write a draft. Try again.' : cur.target.draft_status === 'handoff' ? (cur.target.owner_note || 'Aelys left this one for you.') : 'No draft yet.'}</div>
    {!draft && cur.target.owner_note && cur.target.draft_status !== 'handoff' && <div className="msg__draft-note">{cur.target.owner_note}</div>}
    <div className="msg__draft-actions">
      {draft && <button type="button" className="msg__btn msg__btn--primary" disabled={busy} onClick={t.sendDraft}><Send size={13} />Send</button>}
      {draft && <button type="button" className="msg__btn" onClick={t.edit}>Edit</button>}
      <button type="button" className={draft ? 'msg__btn' : 'msg__btn msg__btn--primary'} aria-label={draft ? 'Rewrite' : 'Draft a reply'} disabled={busy || generating} onClick={() => t.rewrite(cur.target)}><RotateCcw size={13} />{draft ? 'Rewrite' : 'Draft a reply'}</button>
      <button type="button" className="msg__btn msg__btn--ghost" onClick={t.skip}>Skip</button>
      {hint && draft && <><span className="msg__grow" /><span className="msg__hint">⌘↵ send · J / K next chat</span></>}
    </div>
  </div>
}

export function Composer({ t }: { t: MessagesState }) {
  return <div className="msg__composer">
    <input value={t.text} onChange={(e) => t.setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) t.sendOwn() }} placeholder="Write a reply…" aria-label="Write a reply" />
    <span role="button" tabIndex={0} aria-label="Send" aria-disabled={!t.text.trim()} className={`msg__send${t.text.trim() ? ' is-on' : ''}`} onClick={t.sendOwn} onKeyDown={(e) => { if (e.key === 'Enter') t.sendOwn() }}><ArrowUp size={14} /></span>
  </div>
}
