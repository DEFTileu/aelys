import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, AtSign, ChevronRight, Paperclip, RefreshCw, Search, SquarePen, Plus, Sun, Target } from 'lucide-react'
import { chatContext, chatContextTabs, chatExtras, chatGroups, chatMessages, chatPlan, chatPrompts, chatQuickActions, type ChatMessage } from '../../data/desktop/chat'
import { takePendingAsk, useDesktopState } from '../../lib/desktopStore'
import './chat.css'

// Tint for icon chips: the design uses the accent color at ~10% alpha.
const soft = (color: string) => color + '1A'
const timeNow = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return <div className="chat-msg chat-msg--user">
      <div className="chat-bubble chat-bubble--user">{message.text}<div className="chat-time chat-time--user">{message.time}</div></div>
      <div className="chat-avatar chat-avatar--user" aria-hidden="true" />
    </div>
  }
  return <div className="chat-msg chat-msg--assistant">
    <div className="chat-orb" aria-hidden="true" />
    <div className="chat-bubble chat-bubble--assistant">{message.text}<div className="chat-time">{message.time}</div></div>
  </div>
}

// Demo state: the conversation and context tab are local; nothing calls the backend.
export function ChatScreen() {
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<ChatMessage[]>([])
  const [ctxTab, setCtxTab] = useState(0)
  const threadRef = useRef<HTMLDivElement>(null)

  // Keep the newest message in view after sending.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sent])

  function appendUser(text: string) {
    setSent(list => [...list, { id: `sent-${list.length + 1}`, role: 'user', text, time: timeNow() }])
  }

  // Questions asked from Home, a toolbar or the command palette arrive once as a user message.
  const { pendingAsk } = useDesktopState()
  useEffect(() => {
    const text = takePendingAsk()
    if (text) appendUser(text)
  }, [pendingAsk])

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    appendUser(text)
    setDraft('')
  }

  return <div className="chat-screen">
    <aside className="chat-glass chat-history" aria-label="Chat history">
      <div className="chat-search-row">
        <div className="chat-search">
          <Search size={16} color="#625D69" aria-hidden="true" />
          <input placeholder="Search chats…" aria-label="Search chats" />
        </div>
        <button type="button" className="chat-icon-btn" title="New chat" aria-label="New chat"><SquarePen size={18} /></button>
      </div>
      <button type="button" className="chat-new"><Plus size={18} />New chat</button>
      {chatGroups.map(group => <div key={group.title}>
        <div className="chat-group-title">{group.title}</div>
        {group.items.map(item => {
          const Icon = item.icon
          return <button type="button" key={item.title} className={item.active ? 'chat-conv chat-conv--active' : 'chat-conv'}>
            <span className="chat-conv__icon" style={{ background: soft(item.color), color: item.color }}><Icon size={16} /></span>
            <span className="chat-conv__body">
              <span className="chat-conv__row"><span className="chat-conv__title">{item.title}</span><span className="chat-conv__when">{item.when}</span></span>
              <span className="chat-conv__text">{item.preview}</span>
            </span>
          </button>
        })}
      </div>)}
    </aside>

    <section className="chat-glass chat-thread" aria-label="Conversation">
      <div className="chat-messages" ref={threadRef} role="log" aria-live="polite">
        {chatMessages.map(message => <Message key={message.id} message={message} />)}

        <div className="chat-plan">
          <div className="chat-plan__head">
            <Sun size={24} color="#E08A12" aria-hidden="true" />
            <div className="chat-plan__titles">
              <div className="chat-card-title">Plan for today</div>
              <div className="chat-card-sub">Wednesday, October 28</div>
            </div>
            <span className="chat-focus"><Target size={14} aria-hidden="true" />Focus: Studies &amp; Aelys</span>
          </div>
          {chatPlan.map(item => {
            const Icon = item.icon
            const ActionIcon = item.actionIcon
            return <div key={item.title} className="chat-plan__row">
              <span className="chat-plan__bar" style={{ background: item.color }} />
              <span className="chat-plan__time">{item.range}</span>
              <span className="chat-plan__icon" style={{ background: soft(item.color), color: item.color }}><Icon size={16} /></span>
              <div className="chat-plan__text">
                <div className="chat-line-title chat-line-title--ellipsis">{item.title}</div>
                <div className="chat-line-sub chat-line-sub--ellipsis">{item.detail}</div>
              </div>
              <button type="button" className={item.primary ? 'chat-plan__action chat-plan__action--primary' : 'chat-plan__action'}>
                <ActionIcon size={14} color={item.actionColor} />{item.action}
              </button>
            </div>
          })}
        </div>

        <div className="chat-extras">
          {chatExtras.map(extra => {
            const Icon = extra.icon
            return <button type="button" key={extra.title} className="chat-extra">
              <Icon size={20} color={extra.color} />
              <span className="chat-extra__text">
                <span className="chat-line-title chat-line-title--ellipsis">{extra.title}</span>
                <span className="chat-line-sub chat-line-sub--ellipsis">{extra.detail}</span>
              </span>
              <ChevronRight size={16} color="#625D69" />
            </button>
          })}
        </div>

        {sent.map(message => <Message key={message.id} message={message} />)}
      </div>

      <div className="chat-composer-row">
        <span className="chat-orb chat-orb--composer" aria-hidden="true" />
        <form className="chat-composer" onSubmit={send} aria-label="Message Aelys">
          <input
            className="chat-composer__input"
            name="ask"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Ask Aelys or take an action…"
            aria-label="Ask Aelys or take an action"
          />
          <button type="button" className="chat-composer__tool" title="Attach" aria-label="Attach"><Paperclip size={18} /></button>
          <button type="button" className="chat-composer__tool" title="Mention" aria-label="Mention"><AtSign size={18} /></button>
          <button type="submit" className="chat-send" title="Send" aria-label="Send"><ArrowRight size={18} /></button>
        </form>
      </div>
    </section>

    <aside className="chat-side">
      <div className="chat-glass chat-card">
        <div className="chat-card-head">
          <div className="chat-card-head__text">
            <h2 className="chat-card-title">Context</h2>
            <div className="chat-card-sub">Updated 2 min ago</div>
          </div>
          <button type="button" className="chat-icon-btn--sm" title="Refresh" aria-label="Refresh context"><RefreshCw size={16} /></button>
        </div>
        <div className="chat-tabs" role="tablist" aria-label="Context period">
          {chatContextTabs.map((tab, i) => <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={i === ctxTab}
            className={i === ctxTab ? 'chat-tab chat-tab--active' : 'chat-tab'}
            onClick={() => setCtxTab(i)}
          >{tab}</button>)}
        </div>
        <div className="chat-ctx-list">
          {chatContext.map(item => {
            const Icon = item.icon
            return <button type="button" key={item.title} className="chat-ctx-item">
              <span className="chat-ctx-item__icon" style={{ background: soft(item.color), color: item.color }}><Icon size={16} /></span>
              <span className="chat-ctx-item__text">
                <span className="chat-line-title">{item.title}</span>
                <span className="chat-line-sub">{item.detail}</span>
              </span>
              <ChevronRight size={16} color="#625D69" />
            </button>
          })}
        </div>
      </div>

      <div className="chat-glass chat-card">
        <h2 className="chat-card-heading">Quick actions</h2>
        <div className="chat-action-list">
          {chatQuickActions.map(action => {
            const Icon = action.icon
            return <button type="button" key={action.title} className="chat-action">
              <Icon size={16} color={action.color} />{action.title}
            </button>
          })}
        </div>
      </div>

      <div className="chat-glass chat-card">
        <h2 className="chat-card-heading">Useful prompts</h2>
        <div className="chat-action-list">
          {chatPrompts.map(prompt => {
            const Icon = prompt.icon
            return <button type="button" key={prompt.title} className="chat-action">
              <Icon size={16} color={prompt.color} />{prompt.title}
            </button>
          })}
        </div>
      </div>
    </aside>
  </div>
}
