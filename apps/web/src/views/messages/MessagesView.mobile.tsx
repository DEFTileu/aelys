import { ChevronLeft, Sparkles } from '../../icons'
import { useMessages, colourOf, initialOf, windowLabel, whenLabel } from './useMessages'
import { messagesFallback, ChatTabs, ChatSearch, ListEmpty, ChatLines, DraftCard, Composer } from './MessagesShared'
import type { ApiStatus } from '../../types'
import type { MessagesState } from './useMessages'
import type { Chat } from '../../lib/telegramMessages'
import './messages-mobile.css'

// One screen at a time: the chat list, or one conversation over the shell with its reply bar pinned at the bottom.
export function MessagesMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useMessages(apiStatus)
  const fallback = messagesFallback(t, 'msg-page msg-m')
  if (fallback) return fallback
  const { view, cur, notice } = t
  return <div className="msg-page msg-m">
    {notice && view === 'list' && <p className="msg__notice" role="status">{notice}</p>}
    {view === 'chat' && cur ? <MobileChat t={t} cur={cur} /> : <MobileList t={t} />}
  </div>
}

function MobileList({ t }: { t: MessagesState }) {
  const { cur, list, needs, draftOfLive, openChat } = t
  return <section className="msg-m__list" aria-label="Chats">
    <div className="msg-m__head"><ChatTabs t={t} /><ChatSearch t={t} /></div>
    <div className="msg-m__rows">
      {list.map((chat) => { const [c, soft] = colourOf(chat.title); const unread = needs(chat) ? chat.waiting : 0
        return <button type="button" key={chat.id} className={`msg-m__row${chat.id === cur?.id ? ' is-on' : ''}`} onClick={() => openChat(chat.id)}>
          <span className="msg__avatar msg__avatar--44" style={{ color: c, background: soft }}>{initialOf(chat.title)}</span>
          <span className="msg-m__row-body">
            <span className="msg-m__row-top"><span className="msg-m__row-name">{chat.title}</span><span className="msg-m__row-time">{whenLabel(chat.lastAt)}</span></span>
            <span className="msg-m__row-bottom"><span className="msg-m__row-last">{(chat.lastMine ? 'You: ' : '') + chat.lastText}</span>
              {!!draftOfLive(chat) && <span className="msg__chip"><Sparkles size={11} />Draft</span>}
              {unread > 0 && <span className="msg__badge">{unread}</span>}</span>
          </span>
        </button> })}
    </div>
    <ListEmpty t={t} />
  </section>
}

function MobileChat({ t, cur }: { t: MessagesState; cur: Chat }) {
  const ink = colourOf(cur.title)
  return <section className="msg-m__chat" aria-label={`Conversation with ${cur.title}`}>
    <header className="msg-m__bar">
      <button type="button" className="msg-m__back" aria-label="Back" onClick={() => t.setView('list')}><ChevronLeft size={22} /></button>
      <span className="msg__avatar msg__avatar--40" style={{ color: ink[0], background: ink[1] }}>{initialOf(cur.title)}</span>
      <div className="msg-m__bar-text"><div className="msg__chat-name">{cur.title}</div><div className="msg__chat-sub">{windowLabel(cur, t.now)}</div></div>
    </header>
    {t.notice && <p className="msg__notice" role="status">{t.notice}</p>}
    <ChatLines cur={cur} />
    <div className="msg-m__dock"><DraftCard t={t} cur={cur} /><Composer t={t} /></div>
  </section>
}
