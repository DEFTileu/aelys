import { PageSkeleton } from '../../components/PageSkeleton'
import { AelysMark } from '../../components/AelysMark'
import { ApiStatusPill } from '../../components/ApiStatusPill'
import { SelectField } from '../../components/controls/SelectionControls'
import { ArrowUp, MessageSquareText, Plus, Search, Settings, Sparkles } from '../../icons'
import { navigate } from '../../lib/router'
import type { AiHook } from './useAi'

// Shared by the desktop columns and the mobile screens; markup and class names stay identical.
export function AiHistory(t: AiHook) {
  const { search, setSearch, running, newChat, filteredConversations, conversationId, loading, setConversationId, setHistoryOpen } = t
  return <aside className="actual-ai__card actual-ai__history" aria-label="Conversations">
    <div className="actual-ai__history-search"><label className="actual-ai__search"><Search size={17} /><input aria-label="Search conversations" placeholder="Search chats…" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="actual-ai__new-icon" aria-label="New chat" title="New chat" disabled={running} onClick={newChat}><Plus size={18} /></button></div>
    <button type="button" className="actual-ai__new" disabled={running} onClick={newChat}><Plus size={18} />New chat</button>
    <div className="actual-ai__list" aria-label="Conversation list">
      <p className="actual-ai__list-label">Your chats</p>
      {filteredConversations.map(item => <button type="button" disabled={running || loading} className={`actual-ai__conversation${item.id === conversationId ? ' actual-ai__conversation--selected' : ''}`} key={item.id} aria-current={item.id === conversationId ? 'true' : undefined} onClick={() => { setConversationId(item.id); setHistoryOpen(false) }}><span className="actual-ai__list-icon"><MessageSquareText size={17} /></span><span>{item.title || 'Untitled conversation'}</span></button>)}
      {!filteredConversations.length && <p className="actual-ai__empty-list">{search.trim() ? 'No matching conversations.' : 'No conversations yet.'}</p>}
    </div>
  </aside>
}

export function AiThread(t: AiHook) {
  const { apiStatus, selectedTitle, providers, providerId, setProviderId, running, loading, lines, partial, notice, message, setMessage, submit, cancel } = t
  return <section className="actual-ai__card actual-ai__thread" aria-label="AI conversation">
    <div className="actual-ai__thread-head"><div><h2>{selectedTitle}</h2><p>Your conversation with Aelys</p></div><ApiStatusPill status={apiStatus} /><button type="button" className="actual-ai__settings" onClick={() => navigate('/settings')}><Settings size={16} />AI settings</button></div>
    <div className="actual-ai__provider"><SelectField label="Chat provider" value={providerId} disabled={running || !providers.length} onChange={setProviderId} options={providers.map(item => ({ value: item.id, label: `${item.kind} · ${String(item.model_policy?.default_model ?? 'auto')}` }))} placeholder="Configure a provider" />{!providers.length && <button type="button" onClick={() => navigate('/settings')}>Configure provider</button>}</div>
    <div className="actual-ai__lines" aria-live="polite">
      {lines.map(line => <article key={line.id} className={`actual-ai__line${line.role === 'user' ? ' actual-ai__line--user' : ''}`}><span className="actual-ai__avatar" aria-hidden="true">{line.role === 'user' ? 'You' : <AelysMark size={32} />}</span><div className="actual-ai__bubble"><strong>{line.role === 'user' ? 'You' : line.role === 'assistant' ? 'Aelys' : line.role}</strong><div>{line.content}</div>{line.created_at && !Number.isNaN(Date.parse(line.created_at)) && <time dateTime={line.created_at}>{new Date(line.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>}</div></article>)}
      {partial && <article className="actual-ai__line"><span className="actual-ai__avatar" aria-hidden="true"><AelysMark size={32} /></span><div className="actual-ai__bubble"><strong>Aelys</strong><div>{partial}</div></div></article>}
      {loading && !lines.length && !partial && <PageSkeleton kind="chat" compact label="conversation" />}
      {!loading && !lines.length && !partial && <div className="actual-ai__welcome"><span className="actual-ai__welcome-icon"><Sparkles size={25} /></span><h2>How can I help?</h2><p>{providers.length ? 'Ask a question or choose a prompt to get started.' : 'Configure a provider in AI settings to start a conversation.'}</p></div>}
    </div>
    {notice && <p className="actual-ai__notice" role="status">{notice}</p>}
    <form className="actual-ai__compose" onSubmit={submit}><span className="actual-ai__compose-icon" aria-hidden="true"><AelysMark size={44} /></span><div className="actual-ai__compose-field"><textarea aria-label="Message Aelys" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask Aelys or take an action…" disabled={running || loading} rows={2} /><button className="actual-ai__send" type="submit" aria-label="Send message" disabled={running || loading || !message.trim() || !providerId || apiStatus !== 'ready'}><ArrowUp size={18} /><span>Send</span></button></div>{running && <button type="button" className="actual-ai__stop" onClick={() => void cancel()}>Stop</button>}</form>
  </section>
}
