import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AIConversation, AIMessage, AIProvider } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { AelysMark } from '../components/AelysMark'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { SelectField } from '../components/controls/SelectionControls'
import { ArrowUp, Calendar, ChevronRight, Folder, MessageSquareText, Plus, Search, Settings, Sparkles, SquareCheck } from '../icons'
import { getSharedApiClient } from '../lib/api'
import { takePendingAsk, useDesktopState } from '../lib/desktopStore'
import { navigate } from '../lib/router'
import { consumeSse } from '../lib/sse'
import type { ApiStatus } from '../types'
import './actual-ai.css'

type ChatLine = Pick<AIMessage, 'id' | 'role' | 'content'> & Partial<Pick<AIMessage, 'created_at'>>
export function AiView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [providers, setProviders] = useState<readonly AIProvider[]>([])
  const [providerId, setProviderId] = useState('')
  const [conversations, setConversations] = useState<readonly AIConversation[]>([])
  const [conversationId, setConversationId] = useState('')
  const [lines, setLines] = useState<readonly ChatLine[]>([])
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [partial, setPartial] = useState('')
  const [notice, setNotice] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const runId = useRef<string>('')
  const busy = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const { pendingAsk } = useDesktopState()
  useEffect(() => { if (pendingAsk) setMessage(takePendingAsk() ?? '') }, [pendingAsk])
  useEffect(() => {
    let active = true
    const client = getSharedApiClient()
    void Promise.all([client.aiProviders(), client.aiConversations()]).then(([items, history]) => {
      if (!active) return
      const enabled = items.filter((item) => item.enabled && item.has_secret)
      setProviders(enabled); setProviderId((id) => enabled.some((item) => item.id === id) ? id : enabled[0]?.id ?? ''); setConversations(history)
    }).catch(() => { if (active) setNotice('Open your owner session in Settings to load AI providers and chats.') })
    return () => { active = false }
  }, [apiStatus])
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => {
    if (!conversationId || busy.current) return
    let active = true; setLoading(true)
    void getSharedApiClient().aiMessages(conversationId).then((items) => { if (active) { setLines(items); setPartial('') } }).catch(() => { if (active) setNotice('Could not load this conversation.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [conversationId])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const prompt = message.trim()
    if (!prompt || busy.current || loading || apiStatus !== 'ready' || !providerId) return
    busy.current = true; setRunning(true); setNotice(''); setPartial(''); runId.current = ''
    const abort = new AbortController(); controller.current = abort
    try {
      const client = getSharedApiClient()
      const conversation = conversationId ? conversations.find((item) => item.id === conversationId) : await client.createAIConversation({ title: prompt.slice(0, 80) }, { queueOnOffline: false })
      if (!conversation) throw new Error('Choose a conversation or start a new chat.')
      if (!conversationId) { setConversations((items) => [conversation, ...items]); setConversationId(conversation.id) }
      const provider = providers.find((item) => item.id === providerId)!
      const run = await client.createAIRun({ conversation_id: conversation.id, message: prompt, routing: { provider_id: providerId, provider: provider.kind, model: String(provider.model_policy?.default_model ?? 'auto') }, idempotency_key: crypto.randomUUID() }, { queueOnOffline: false })
      runId.current = run.id; setMessage(''); setLines((items) => [...items, { id: run.id, role: 'user', content: prompt }])
      let terminal = false
      await consumeSse(await client.aiRunEvents(run.id, { signal: abort.signal }), (name, data) => {
        if (name === 'ai.text.delta') setPartial((value) => value + String(data.text ?? ''))
        if (name === 'ai.run.failed') { terminal = true; setNotice(String(data.message ?? 'Provider failed. Check its key and model in Settings.')) }
        if (name === 'ai.run.cancelled') { terminal = true; setNotice('Run cancelled.') }
        if (name === 'ai.run.completed') terminal = true
      })
      if (!terminal) throw new Error('The connection ended before the provider confirmed completion. Reload the conversation to check its status.')
      setLines(await client.aiMessages(conversation.id)); setPartial('')
    } catch (error) { setNotice(error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'AI request failed') }
    finally { busy.current = false; setRunning(false); controller.current = null }
  }
  const cancel = async () => {
    if (!runId.current) return
    try { await getSharedApiClient().cancelAIRun(runId.current); setNotice('Cancellation requested.') }
    catch { setNotice('Could not confirm cancellation. Try again.') }
  }
  const filteredConversations = conversations.filter((item) => (item.title ?? '').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const selectedTitle = conversations.find((item) => item.id === conversationId)?.title || 'New conversation'
  const newChat = () => { setConversationId(''); setLines([]); setPartial(''); setNotice(''); setHistoryOpen(false) }
  const prompts = [
    { label: 'Plan my day', text: 'Help me make a realistic plan for today.' },
    { label: 'Break down a task', text: 'Help me break a task into manageable steps.' },
    { label: 'Think through priorities', text: 'Help me decide what to prioritize.' },
  ]
  return <div className={`actual-ai${historyOpen ? ' actual-ai--history-open' : ''}`}>
    <div className="actual-ai__mobile-head"><div><h2>AI Chat</h2><p>How can I help?</p></div><button type="button" onClick={newChat} disabled={running}><Plus size={18} />New chat</button><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Chats</button></div>
    <aside className="actual-ai__card actual-ai__history" aria-label="Conversations">
      <div className="actual-ai__history-search"><label className="actual-ai__search"><Search size={17} /><input aria-label="Search conversations" placeholder="Search chats…" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="actual-ai__new-icon" aria-label="New chat" title="New chat" disabled={running} onClick={newChat}><Plus size={18} /></button></div>
      <button type="button" className="actual-ai__new" disabled={running} onClick={newChat}><Plus size={18} />New chat</button>
      <div className="actual-ai__list" aria-label="Conversation list">
        <p className="actual-ai__list-label">Your chats</p>
        {filteredConversations.map(item => <button type="button" disabled={running || loading} className={`actual-ai__conversation${item.id === conversationId ? ' actual-ai__conversation--selected' : ''}`} key={item.id} aria-current={item.id === conversationId ? 'true' : undefined} onClick={() => { setConversationId(item.id); setHistoryOpen(false) }}><span className="actual-ai__list-icon"><MessageSquareText size={17} /></span><span>{item.title || 'Untitled conversation'}</span></button>)}
        {!filteredConversations.length && <p className="actual-ai__empty-list">{search.trim() ? 'No matching conversations.' : 'No conversations yet.'}</p>}
      </div>
    </aside>
    <section className="actual-ai__card actual-ai__thread" aria-label="AI conversation">
      <div className="actual-ai__thread-head"><div><h2>{selectedTitle}</h2><p>Your conversation with Aelys</p></div><ApiStatusPill status={apiStatus} /><button type="button" className="actual-ai__settings" onClick={() => navigate('/settings')}><Settings size={16} />AI settings</button></div>
      <div className="actual-ai__provider"><SelectField label="Chat provider" value={providerId} disabled={running || !providers.length} onChange={setProviderId} options={providers.map(item => ({ value: item.id, label: `${item.kind} · ${String(item.model_policy?.default_model ?? 'auto')}` }))} placeholder="Configure a provider" />{!providers.length && <button type="button" onClick={() => navigate('/settings')}>Configure provider</button>}</div>
      <div className="actual-ai__lines" aria-live="polite">
        {lines.map(line => <article key={line.id} className={`actual-ai__line${line.role === 'user' ? ' actual-ai__line--user' : ''}`}><span className="actual-ai__avatar" aria-hidden="true">{line.role === 'user' ? 'You' : <AelysMark size={32} />}</span><div className="actual-ai__bubble"><strong>{line.role === 'user' ? 'You' : line.role === 'assistant' ? 'Aelys' : line.role}</strong><div>{line.content}</div>{line.created_at && !Number.isNaN(Date.parse(line.created_at)) && <time dateTime={line.created_at}>{new Date(line.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>}</div></article>)}
        {partial && <article className="actual-ai__line"><span className="actual-ai__avatar" aria-hidden="true"><AelysMark size={32} /></span><div className="actual-ai__bubble"><strong>Aelys</strong><div>{partial}</div></div></article>}
        {!lines.length && !partial && <div className="actual-ai__welcome"><span className="actual-ai__welcome-icon"><Sparkles size={25} /></span><h2>{loading ? 'Loading conversation…' : 'How can I help?'}</h2><p>{providers.length ? 'Ask a question or choose a prompt to get started.' : 'Configure a provider in AI settings to start a conversation.'}</p></div>}
      </div>
      {notice && <p className="actual-ai__notice" role="status">{notice}</p>}
      <form className="actual-ai__compose" onSubmit={submit}><span className="actual-ai__compose-icon" aria-hidden="true"><AelysMark size={44} /></span><div className="actual-ai__compose-field"><textarea aria-label="Message Aelys" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask Aelys or take an action…" disabled={running || loading} rows={2} /><button className="actual-ai__send" type="submit" aria-label="Send message" disabled={running || loading || !message.trim() || !providerId || apiStatus !== 'ready'}><ArrowUp size={18} /><span>Send</span></button></div>{running && <button type="button" className="actual-ai__stop" onClick={() => void cancel()}>Stop</button>}</form>
    </section>
    <aside className="actual-ai__side" aria-label="Chat resources">
      <section className="actual-ai__card actual-ai__side-card actual-ai__context"><h2><Sparkles size={17} />Context</h2><p className="actual-ai__side-copy">Open your workspace to review your information.</p><div className="actual-ai__actions">
        <button type="button" onClick={() => navigate('/tasks')}><span><SquareCheck size={17} /></span><b>Tasks</b><ChevronRight size={16} /></button>
        <button type="button" onClick={() => navigate('/calendar')}><span><Calendar size={17} /></span><b>Calendar</b><ChevronRight size={16} /></button>
        <button type="button" onClick={() => navigate('/projects')}><span><Folder size={17} /></span><b>Projects</b><ChevronRight size={16} /></button>
      </div></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__quick"><h2>Quick actions</h2><div className="actual-ai__prompts"><button type="button" onClick={() => navigate('/tasks')}><SquareCheck size={16} />Open tasks</button><button type="button" onClick={() => navigate('/notes')}><MessageSquareText size={16} />Open notes</button><button type="button" onClick={() => navigate('/calendar')}><Calendar size={16} />Open calendar</button></div></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__useful"><h2>Useful prompts</h2><p className="actual-ai__side-copy">Choose a prompt to edit before sending.</p><div className="actual-ai__prompts">{prompts.map(prompt => <button type="button" key={prompt.label} disabled={running || loading} onClick={() => setMessage(prompt.text)}><Sparkles size={16} />{prompt.label}</button>)}</div></section>
    </aside>
  </div>
}
