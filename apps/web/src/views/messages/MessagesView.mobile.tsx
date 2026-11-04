import { ChatAvatar } from '../../components/ChatAvatar'
import { ArrowUp, Check, ChevronLeft, RotateCcw, Search, Send, Sparkles } from '../../icons'
import { TelegramMediaPreview } from '../../components/TelegramMediaPreview'
import { PageSkeleton } from '../../components/PageSkeleton'
import { navigate } from '../../lib/router'
import type { ApiStatus } from '../../types'
import '../desktop/page-tokens.css'
import '../messages.css'
import { colourOf, initialOf, whenLabel, windowLabel, useMessages } from './useMessages'

export function MessagesMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const { status, setReplies, text, draft, phase, setPhase, load, tab, setTab, query, setQuery, cur, setCurrent, setView, list, skip, edit, busy, notice, now, compact, chats, needs, draftOfLive, needCount, reply, available, setText, deliveryUncertain, canSend, unavailableReason, sendDraft, sendOwn, rewrite, showList, showChat, ink, generating, failed } = useMessages(apiStatus)
  if (phase !== 'ready') return <div className="msg-page"><PageSkeleton kind="split" label="messages" phase={phase === 'error' ? 'error' : 'loading'} compact={compact} onRetry={() => { setPhase('loading'); void load() }} /></div>
  if (!status?.configured) return <div className="msg-page"><div className="msg msg--solo"><div className="msg__empty"><Send size={28} /><div className="msg__empty-title">Telegram is not connected</div><div>Connect a Telegram bot in Settings to see your chats here.</div><button type="button" className="msg__btn msg__btn--primary" onClick={() => navigate('/settings')}>Open Settings</button></div></div></div>

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
              <ChatAvatar chatId={chat.chatId} initial={initialOf(chat.title)} className="msg__avatar msg__avatar--44" style={{ color: c, background: soft }} />
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
            <ChatAvatar chatId={cur.chatId} initial={initialOf(cur.title)} className="msg__avatar msg__avatar--40" style={{ color: ink[0], background: ink[1] }} />
            <div className="msg__chat-title"><div className="msg__chat-name">{cur.title}</div><div className="msg__chat-sub">{windowLabel(cur, now)}</div></div>
          </div>
          <div className="msg__lines">
            {cur.lines.map((line) => <div key={line.id} className={`msg__line${line.mine ? ' is-out' : ''}`}>
              <div className={`msg__bubble${line.deleted ? ' is-deleted' : ''}`}>
                {line.replyToId && <div className="msg__quote">{cur.lines.find(source => source.remoteId === line.replyToId && !source.deleted)?.text ?? 'Earlier message'}</div>}
                {line.media && <TelegramMediaPreview messageId={line.id} version={cur.messages.find(message => message.id === line.id)?.version ?? 1} kind={line.media.kind}/>}
                {(!line.media || cur.messages.find(message => message.id === line.id)?.text) && line.text}
              </div>
              <div className="msg__meta">{line.byAelys ? <><Sparkles size={11} />Sent by Aelys ·<span>{whenLabel(line.at)}</span></> : whenLabel(line.at)}{!line.deleted && !!line.remoteId && <button type="button" className="msg__reply" disabled={busy || !available() || deliveryUncertain} aria-label="Reply to message" onClick={() => setReplies(all => ({ ...all, [cur.id]: { remoteId: line.remoteId!, text: line.text } }))}>Reply</button>}</div>
            </div>)}
          </div>
          <div className="msg__bottom">
            {cur.target && !cur.target.media && !cur.target.deleted_at && (draft || generating || failed || (cur.needsReply && cur.target.draft_status !== 'ready')) && <div className="msg__draft">
              <div className="msg__draft-title"><Sparkles size={12} />Aelys draft</div>
              <div className="msg__draft-text">{draft ? draft.draft_text : generating ? 'Aelys is writing a reply…' : failed ? 'Aelys could not write a draft. Try again.' : cur.target.draft_status === 'handoff' ? (cur.target.owner_note || 'Aelys left this one for you.') : 'No draft yet.'}</div>
              {!draft && cur.target.owner_note && cur.target.draft_status !== 'handoff' && <div className="msg__draft-note">{cur.target.owner_note}</div>}
              <div className="msg__draft-actions">
                {draft && <button type="button" className="msg__btn msg__btn--primary" disabled={!canSend} onClick={sendDraft}><Send size={13} />Send</button>}
                {draft && <button type="button" className="msg__btn" onClick={edit}>Edit</button>}
                <button type="button" className={draft ? 'msg__btn' : 'msg__btn msg__btn--primary'} aria-label={draft ? 'Rewrite' : 'Draft a reply'} disabled={!canSend || generating} onClick={() => rewrite(cur.target)}><RotateCcw size={13} />{compact ? '' : draft ? 'Rewrite' : 'Draft a reply'}</button>
                <button type="button" className="msg__btn msg__btn--ghost" onClick={skip}>Skip</button>
                {!compact && draft && <><span className="msg__grow" /><span className="msg__hint">⌘↵ send · J / K next chat</span></>}
              </div>
            </div>}
            {reply && <div className="msg__reply-target" aria-label="Replying to message"><div><strong>Replying to</strong><p>{reply.text}</p></div><button type="button" className="msg__btn" aria-label="Cancel reply" onClick={() => setReplies(all => ({ ...all, [cur.id]: undefined }))}>Cancel reply</button></div>}
            <div className="msg__composer">
              <input maxLength={4096} aria-describedby={unavailableReason ? 'chat-send-unavailable' : undefined} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendOwn() } }} placeholder="Write a reply…" aria-label="Write a reply" />
              <button type="button" aria-label="Send message" disabled={!canSend || !text.trim() || text.length > 4096} className={`msg__send${canSend && text.trim() ? ' is-on' : ''}`} onClick={sendOwn}><ArrowUp size={14} /></button>
            </div>
            {unavailableReason && <p id="chat-send-unavailable" className="msg__hint" role="status">{unavailableReason}</p>}
          </div>
        </> : <div className="msg__empty msg__empty--chat"><Send size={28} /><div className="msg__empty-title">No messages yet</div><div className="msg__empty-sub">Messages from Telegram Business appear here</div></div>}
      </div>}
    </div>
  </div>
}
