import { PageSkeleton } from '../components/PageSkeleton'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AIConversation, AIMessage, AIProvider, KnowledgeScope, KnowledgeSource } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { AelysMark } from '../components/AelysMark'
import { ModelPicker } from '../components/ModelPicker'
import { ArrowUp, Calendar, Lock, MessageSquareText, Plus, RotateCcw, Search, Sparkles, SquareCheck, Zap } from '../icons'
import { DEFAULT_CHOICE_KEY, EFFORT_SHORT, chatChoiceKey, choiceLabel, clearChoice, isReady, modelsFor, providerLabel, readChoice, resolveChoice, supportsThinking, writeChoice, type Effort, type ModelChoice } from '../data/aiModels'
import { getSharedApiClient } from '../lib/api'
import { takePendingAsk, useDesktopState } from '../lib/desktopStore'
import { navigate } from '../lib/router'
import { consumeSse } from '../lib/sse'
import type { ApiStatus } from '../types'
import './actual-ai.css'
import './desktop/page-tokens.css'
import './desktop/ai.css'
import { MarkdownContent } from '../components/MarkdownContent'

type ChatLine = Pick<AIMessage, 'id' | 'role' | 'content'> & Partial<Pick<AIMessage, 'created_at' | 'source_refs_json'>>
/** How the latest run ended in this session; drives the meta line, the Stopped label and the error card. */
interface Outcome { readonly status: 'done' | 'stopped' | 'error'; readonly prompt: string; readonly provider: string; readonly model: string; readonly ms?: number; readonly cost?: string; readonly effort?: Effort; readonly code?: string; readonly message?: string }
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const money = (value: number) => value === 0 ? '≈$0' : `≈$${value.toFixed(value < 0.01 ? 4 : 2)}`
export function AiView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [message, setMessage] = useState('')
  const [knowledgeScope, setKnowledgeScope] = useState<KnowledgeScope>()
  const [sources, setSources] = useState<readonly KnowledgeSource[]>([])
  const [search, setSearch] = useState('')
  const [allProviders, setAllProviders] = useState<readonly AIProvider[]>([])
  const [pick, setPick] = useState<ModelChoice | null>(() => readChoice(DEFAULT_CHOICE_KEY))
  const [outcome, setOutcome] = useState<Outcome>()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [chatCost, setChatCost] = useState(0)
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
  const { pendingAsk, pendingKnowledge } = useDesktopState()
  const providers = allProviders.filter(isReady)
  const active = resolveChoice(pick, providers)
  const providerId = active.providerId
  const defaultStored = readChoice(DEFAULT_CHOICE_KEY)
  const isDefault = defaultStored?.providerId === active.providerId && defaultStored.model === active.model
  const applyChoice = (choice: ModelChoice) => { setPick(choice); if (conversationId) writeChoice(chatChoiceKey(conversationId), choice) }
  const toggleDefault = (on: boolean) => { if (on) writeChoice(DEFAULT_CHOICE_KEY, active); else clearChoice(DEFAULT_CHOICE_KEY); setPick({ ...active }) }
  const resetRun = () => { setOutcome(undefined); setHidden(new Set()); setChatCost(0) }
  useEffect(() => {
    if (!pendingAsk) return
    const question = takePendingAsk()
    // StrictMode replays effects: consuming twice must not erase the first draft.
    if (!question) return
    setKnowledgeScope(pendingKnowledge); setConversationId(''); setLines([]); setSources([]); setMessage(question); setPick(readChoice(DEFAULT_CHOICE_KEY)); setOutcome(undefined); setHidden(new Set()); setChatCost(0)
  }, [pendingAsk, pendingKnowledge])
  useEffect(() => {
    let active = true
    const client = getSharedApiClient()
    void Promise.all([client.aiProviders(), client.aiConversations()]).then(([items, history]) => {
      if (!active) return
      setAllProviders(items.filter((item) => item.kind !== 'transcription')); setConversations(history)
    }).catch(() => { if (active) setNotice('Could not load AI providers and chats. Check your connection and reopen this page.') })
    return () => { active = false }
  }, [apiStatus])
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => {
    if (!conversationId || busy.current) return
    let active = true; setLoading(true)
    void getSharedApiClient().aiMessages(conversationId).then((items) => { if (active) { setLines(items); setPartial('') } }).catch(() => { if (active) setNotice('Could not load this conversation.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [conversationId])
  const execute = async (prompt: string, replace?: { now?: readonly string[]; after?: readonly string[] }, override?: ModelChoice) => {
    const choice = override ?? active
    if (!prompt || busy.current || loading || apiStatus !== 'ready' || !choice.providerId) return
    busy.current = true; setRunning(true); setNotice(''); setPartial(''); setOutcome(undefined); runId.current = ''
    if (replace?.now?.length) setHidden((ids) => new Set([...ids, ...replace.now!]))
    const abort = new AbortController(); controller.current = abort
    const known = new Set(lines.map((line) => line.id))
    try {
      const client = getSharedApiClient()
      const conversation = conversationId ? conversations.find((item) => item.id === conversationId) : await client.createAIConversation({ title: prompt.slice(0, 80), ...(knowledgeScope ? { knowledge: knowledgeScope, project_id: knowledgeScope.project_id } : {}) }, { queueOnOffline: false })
      if (!conversation) throw new Error('Choose a conversation or start a new chat.')
      if (!conversationId) { setConversations((items) => [conversation, ...items]); setConversationId(conversation.id) }
      writeChoice(chatChoiceKey(conversation.id), choice); if (override) setPick(choice)
      const provider = providers.find((item) => item.id === choice.providerId)!
      const effort = choice.effort && choice.effort !== 'off' && supportsThinking(provider, choice.model) ? choice.effort : undefined
      const run = await client.createAIRun({ conversation_id: conversation.id, message: prompt, routing: { provider_id: provider.id, provider: provider.kind, model: choice.model, ...(effort ? { effort } : {}) }, idempotency_key: crypto.randomUUID(), ...(knowledgeScope ? { knowledge: knowledgeScope } : {}) }, { queueOnOffline: false })
      runId.current = run.id
      if (!replace) { setMessage(''); setLines((items) => [...items, { id: run.id, role: 'user', content: prompt }]) }
      let terminal: Outcome | undefined; let streamed = ''; let startedAt = Date.now(); let used: { provider: string; model: string } = { provider: provider.kind, model: choice.model }
      await consumeSse(await client.aiRunEvents(run.id, { signal: abort.signal }), (name, data) => {
        if (name === 'ai.knowledge.sources' && Array.isArray(data.sources)) setSources(data.sources as unknown as readonly KnowledgeSource[])
        if (name === 'ai.run.started') { startedAt = Date.now(); used = { provider: String(data.provider ?? used.provider), model: String(data.model ?? used.model) } }
        if (name === 'ai.text.delta') { streamed += String(data.text ?? ''); setPartial(streamed) }
        const base = { prompt, ...(effort ? { effort } : {}) }
        if (name === 'ai.run.failed') terminal = { ...base, ...used, status: 'error', code: String(data.code ?? 'AI_ERROR'), message: String(data.message ?? 'Provider failed. Check its key and model in Settings.') }
        if (name === 'ai.run.cancelled') terminal = { ...base, ...used, status: 'stopped' }
        if (name === 'ai.run.completed') terminal = { ...base, ...used, status: 'done', ms: Date.now() - startedAt, ...(data.estimated_cost != null ? { cost: String(data.estimated_cost) } : {}) }
      })
      if (!terminal) throw new Error('The connection ended before the provider confirmed completion. Reload the conversation to check its status.')
      let items: readonly ChatLine[] = await client.aiMessages(conversation.id)
      // A stopped run keeps its partial text even when the server did not store it.
      if (terminal.status === 'stopped' && streamed && !items.some((item) => item.role === 'assistant' && !known.has(item.id))) items = [...items, { id: `stopped-${run.id}`, role: 'assistant', content: streamed }]
      setLines(items); setPartial(''); setOutcome(terminal)
      if (replace?.after?.length) setHidden((ids) => new Set([...ids, ...replace.after!]))
      if (terminal.status === 'done' && terminal.cost && Number.isFinite(Number(terminal.cost))) setChatCost((total) => total + Number(terminal!.cost))
    } catch (error) { setNotice(error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'AI request failed') }
    finally { busy.current = false; setRunning(false); controller.current = null }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void execute(message.trim()) }
  const shown = lines.filter((line) => !hidden.has(line.id))
  const lastAssistant = [...shown].reverse().find((line) => line.role === 'assistant')
  const lastUser = [...shown].reverse().find((line) => line.role === 'user')
  const regenerate = () => {
    if (!lastAssistant) return
    const index = shown.indexOf(lastAssistant); const user = [...shown.slice(0, index)].reverse().find((line) => line.role === 'user')
    if (user) void execute(user.content, { now: [lastAssistant.id], after: [user.id] })
  }
  const fastest = providers.flatMap((provider) => modelsFor(provider).filter((model) => !(provider.id === active.providerId && model.id === active.model)).map((model) => ({ provider, model }))).sort((a, b) => (b.model.speed ?? 0) - (a.model.speed ?? 0))[0]
  const cancel = async () => {
    if (!runId.current) return
    try { await getSharedApiClient().cancelAIRun(runId.current); setNotice('Cancellation requested.') }
    catch { setNotice('Could not confirm cancellation. Try again.') }
  }
  const filteredConversations = conversations.filter((item) => (item.title ?? '').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const selectedTitle = conversations.find((item) => item.id === conversationId)?.title || 'New conversation'
  const newChat = () => { setKnowledgeScope(undefined); setSources([]); setConversationId(''); setLines([]); setPartial(''); setNotice(''); setHistoryOpen(false); resetRun(); setPick(readChoice(DEFAULT_CHOICE_KEY)) }
  const prompts = [
    { label: 'Plan my day', text: 'Help me make a realistic plan for today.' },
    { label: 'Break down a task', text: 'Help me break a task into manageable steps.' },
    { label: 'Think through priorities', text: 'Help me decide what to prioritize.' },
  ]
  return <div className={`actual-ai${historyOpen ? ' actual-ai--history-open' : ''}`}>
    <div className="actual-ai__mobile-head"><h2>AI Chat</h2><button type="button" onClick={newChat} disabled={running}><Plus size={18} />New chat</button><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Chats</button><div className="actual-ai__greeting"><p>How can I help?</p><span>I’ll help you plan the day, sort out tasks and focus on what matters.</span></div></div>
    <aside className="actual-ai__card actual-ai__history" aria-label="Conversations">
      <div className="actual-ai__history-search"><label className="actual-ai__search"><Search size={17} /><input aria-label="Search conversations" placeholder="Search chats…" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="actual-ai__new-icon" aria-label="New chat" title="New chat" disabled={running} onClick={newChat}><Plus size={18} /></button></div>
      <button type="button" className="actual-ai__new" disabled={running} onClick={newChat}><Plus size={18} />New chat</button>
      <div className="actual-ai__list" aria-label="Conversation list">
        <p className="actual-ai__list-label">Your chats</p>
        {filteredConversations.map(item => <button type="button" disabled={running || loading} className={`actual-ai__conversation${item.id === conversationId ? ' actual-ai__conversation--selected' : ''}`} key={item.id} aria-current={item.id === conversationId ? 'true' : undefined} onClick={() => { setConversationId(item.id); setKnowledgeScope(item.tool_scope_json?.knowledge); setSources([]); setHistoryOpen(false); resetRun(); setPick(readChoice(chatChoiceKey(item.id)) ?? readChoice(DEFAULT_CHOICE_KEY)) }}><span className="actual-ai__list-icon"><MessageSquareText size={17} /></span><span>{item.title || 'Untitled conversation'}</span></button>)}
        {!filteredConversations.length && <p className="actual-ai__empty-list">{search.trim() ? 'No matching conversations.' : 'No conversations yet.'}</p>}
      </div>
    </aside>
    <section className="actual-ai__card actual-ai__thread" aria-label="AI conversation">
      <div className="actual-ai__thread-head"><div><h2>{selectedTitle}</h2><p>Your conversation with Aelys</p></div>
        <ModelPicker providers={allProviders} value={active} onChange={applyChoice} disabled={running} showEffort isDefault={isDefault} onToggleDefault={toggleDefault} /></div>
      <div className="actual-ai__lines" aria-live="polite">
        {shown.map(line => <article key={line.id} className={`actual-ai__line${line.role === 'user' ? ' actual-ai__line--user' : ''}`}><span className="actual-ai__avatar" aria-hidden="true">{line.role === 'user' ? 'You' : <AelysMark size={32} />}</span><div className="actual-ai__bubble"><strong>{line.role === 'user' ? 'You' : line.role === 'assistant' ? 'Aelys' : line.role}</strong><MarkdownContent text={line.content} />{line.source_refs_json?.length ? <SourceList sources={line.source_refs_json} /> : null}{line.created_at && !Number.isNaN(Date.parse(line.created_at)) && <time dateTime={line.created_at}>{new Date(line.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>}
          {line.role === 'assistant' && <div className="actual-ai__tools">
            <button type="button" className="actual-ai__copy" onClick={() => void navigator.clipboard?.writeText(line.content)}>Copy</button>
            {line === lastAssistant && <button type="button" className="actual-ai__tool" aria-label="Regenerate" title="Regenerate" disabled={running || loading || !providerId} onClick={regenerate}><RotateCcw size={15} /></button>}
            {line === lastAssistant && outcome?.status === 'done' && <span className="actual-ai__meta">{[providerLabel(outcome.provider), outcome.model, outcome.ms != null ? seconds(outcome.ms) : '', outcome.cost != null && Number.isFinite(Number(outcome.cost)) ? money(Number(outcome.cost)) : '', outcome.effort ? `${outcome.effort} effort` : ''].filter(Boolean).join(' · ')}</span>}
          </div>}</div></article>)}
        {partial && <article className="actual-ai__line"><span className="actual-ai__avatar" aria-hidden="true"><AelysMark size={32} /></span><div className="actual-ai__bubble"><strong>Aelys</strong><MarkdownContent text={partial} /></div></article>}
        {running && !partial && <article className="actual-ai__line"><span className="actual-ai__avatar" aria-hidden="true"><AelysMark size={32} /></span><div className="actual-ai__bubble"><span className="actual-ai__dots" role="status" aria-label="Aelys is thinking"><i /><i /><i /></span></div></article>}
        {outcome?.status === 'stopped' && <p className="actual-ai__stopped">{lastAssistant && shown[shown.length - 1] === lastAssistant ? 'Stopped' : 'Stopped before answering'}</p>}
        {outcome?.status === 'error' && <div className="actual-ai__error" role="alert"><div><b>{outcome.message}</b><span>{outcome.code} · Nothing was lost. You can retry or ask a different model.</span></div>
          <div className="actual-ai__error-actions"><button type="button" disabled={running} onClick={() => void execute(outcome.prompt, { after: lastUser ? [lastUser.id] : [] })}><RotateCcw size={15} />Retry</button>
            {fastest && <button type="button" disabled={running} onClick={() => void execute(outcome.prompt, { after: lastUser ? [lastUser.id] : [] }, { providerId: fastest.provider.id, model: fastest.model.id })}><Zap size={15} />Try {fastest.model.name}</button>}</div></div>}
        {loading && !shown.length && !partial && <PageSkeleton kind="chat" compact label="conversation" />}
        {!loading && !shown.length && !partial && !running && <div className="actual-ai__welcome"><span className="actual-ai__welcome-icon"><Sparkles size={25} /></span><h2>{loading ? 'Loading conversation…' : 'How can I help?'}</h2><p>{providers.length ? 'Ask a question or choose a prompt to get started.' : 'Configure a provider in AI settings to start a conversation.'}</p></div>}
      </div>
      {sources.length > 0 && running && <SourceList sources={sources} />}
      {knowledgeScope && <p className="actual-ai__notice">Knowledge question · {knowledgeScope.note_ids?.length ? 'selected document' : knowledgeScope.project_id ? 'selected project' : 'enabled library'} · excerpts go to the selected provider <button type="button" disabled={running} onClick={() => { setKnowledgeScope(undefined); setConversationId(''); setLines([]); setSources([]) }}>Clear sources</button></p>}
      {notice && <p className="actual-ai__notice" role="status">{notice}</p>}
      <form className="actual-ai__compose" onSubmit={submit}><span className="actual-ai__compose-icon" aria-hidden="true"><AelysMark size={44} /></span><div className="actual-ai__compose-field"><textarea aria-label="Message Aelys" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask Aelys or take an action…" disabled={running || loading} rows={2} /><button className="actual-ai__send" type="submit" aria-label="Send message" disabled={running || loading || !message.trim() || !providerId || apiStatus !== 'ready'}><ArrowUp size={18} /><span>Send</span></button></div>{running && <button type="button" className="actual-ai__stop" onClick={() => void cancel()}>Stop</button>}</form>
    </section>
    <aside className="actual-ai__side" aria-label="Chat resources">
      <section className="actual-ai__card actual-ai__side-card actual-ai__context"><h2>What Aelys can see</h2><p className="actual-ai__side-copy">In this chat only. Aelys reads, it never changes data without asking.</p>
        <ul className="actual-ai__see">
          {(conversations.find(item => item.id === conversationId)?.tool_scope_json?.scopes ?? []).map(scope => <li key={scope}>{scope}</li>)}
          {knowledgeScope && <li>{knowledgeScope.note_ids?.length ? 'Selected document' : knowledgeScope.project_id ? 'Selected project' : 'Enabled library'}{sources.length > 0 ? ` · ${sources.length} ${sources.length === 1 ? 'source' : 'sources'} retrieved` : ''}</li>}
          {!knowledgeScope && !(conversations.find(item => item.id === conversationId)?.tool_scope_json?.scopes?.length) && <li>Only this conversation</li>}
        </ul></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__chatinfo"><h2>This chat{chatCost > 0 && <span className="actual-ai__cost">{money(chatCost)} this session</span>}</h2>
        <dl><div><dt>Model</dt><dd>{providerId ? choiceLabel(providers.find(item => item.id === providerId), active) : 'None'}</dd></div>
          {supportsThinking(providers.find(item => item.id === providerId), active.model) && active.effort && active.effort !== 'off' && <div><dt>Reasoning</dt><dd>{EFFORT_SHORT[active.effort]}</dd></div>}
          <div><dt>Messages</dt><dd>{shown.length}</dd></div></dl></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__quick"><h2>Quick actions</h2><div className="actual-ai__prompts"><button type="button" onClick={() => navigate('/tasks')}><SquareCheck size={16} />Open tasks</button><button type="button" onClick={() => navigate('/notes')}><MessageSquareText size={16} />Open notes</button><button type="button" onClick={() => navigate('/calendar')}><Calendar size={16} />Open calendar</button></div></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__useful"><h2>Useful prompts</h2><p className="actual-ai__side-copy">Choose a prompt to edit before sending.</p><div className="actual-ai__prompts">{prompts.map(prompt => <button type="button" key={prompt.label} disabled={running || loading} onClick={() => setMessage(prompt.text)}><Sparkles size={16} />{prompt.label}</button>)}</div></section>
      <p className="actual-ai__privacy"><Lock size={14} aria-hidden="true" />Messages go to the provider you pick. Keys stay on your Aelys backend.</p>
    </aside>
  </div>
}

function SourceList({ sources }: { sources: readonly KnowledgeSource[] }) {
  return <details className="knowledge-sources"><summary>Retrieved sources ({sources.length})</summary><ul>{sources.map(source => <li key={source.label}><a href={`/notes?note=${encodeURIComponent(source.note_id)}&version=${source.version}&start=${source.start}`} target="_blank" rel="noopener noreferrer">[{source.label}] {source.title} · v{source.version}{source.heading ? ` · ${source.heading}` : ''}</a><blockquote>{source.excerpt}</blockquote></li>)}</ul></details>
}
