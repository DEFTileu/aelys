import { Send, Sparkles } from '../../icons'
import { useMessages, colourOf, initialOf, windowLabel, whenLabel, AVATAR_DEFAULT } from './useMessages'
import { messagesFallback, ChatTabs, ChatSearch, ListEmpty, ChatLines, DraftCard, Composer } from './MessagesShared'
import type { ApiStatus } from '../../types'

export function MessagesDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useMessages(apiStatus)
  const fallback = messagesFallback(t, 'msg-page')
  if (fallback) return fallback
  const { cur, list, notice, now, needs, draftOfLive, openChat } = t
  const ink = cur ? colourOf(cur.title) : AVATAR_DEFAULT

  return <div className="msg-page">
    {notice && <p className="msg__notice" role="status">{notice}</p>}
    <div className="msg">
      <div className="msg__list">
        <div className="msg__list-head"><ChatTabs t={t} /><ChatSearch t={t} /></div>
        <div className="msg__rows" role="listbox" aria-label="Chats">
          {list.map((chat) => { const [c, soft] = colourOf(chat.title); const on = chat.id === cur?.id; const unread = needs(chat) ? chat.waiting : 0
            return <div key={chat.id} role="option" tabIndex={0} aria-selected={on} className={`msg__row${on ? ' is-on' : ''}`} onClick={() => openChat(chat.id)} onKeyDown={(e) => { if (e.key === 'Enter') openChat(chat.id) }}>
              <span className="msg__avatar msg__avatar--44" style={{ color: c, background: soft }}>{initialOf(chat.title)}</span>
              <div className="msg__row-body">
                <div className="msg__row-top"><span className="msg__row-name">{chat.title}</span><span className="msg__row-time">{whenLabel(chat.lastAt)}</span></div>
                <div className="msg__row-bottom"><span className="msg__row-last">{(chat.lastMine ? 'You: ' : '') + chat.lastText}</span>
                  {!!draftOfLive(chat) && <span className="msg__chip"><Sparkles size={11} />Draft</span>}
                  {unread > 0 && <span className="msg__badge">{unread}</span>}</div>
              </div>
            </div> })}
          <ListEmpty t={t} />
        </div>
      </div>

      <div className="msg__chat">
        {cur ? <>
          <div className="msg__chat-head">
            <span className="msg__avatar msg__avatar--40" style={{ color: ink[0], background: ink[1] }}>{initialOf(cur.title)}</span>
            <div className="msg__chat-title"><div className="msg__chat-name">{cur.title}</div><div className="msg__chat-sub">{windowLabel(cur, now)}</div></div>
          </div>
          <ChatLines cur={cur} />
          <div className="msg__bottom"><DraftCard t={t} cur={cur} hint /><Composer t={t} /></div>
        </> : <div className="msg__empty msg__empty--chat"><Send size={28} /><div className="msg__empty-title">No messages yet</div><div className="msg__empty-sub">Messages from Telegram Business appear here</div></div>}
      </div>
    </div>
  </div>
}
