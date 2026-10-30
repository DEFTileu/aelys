import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AIConversation, AIMessage, AIProvider } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { getSharedApiClient } from '../lib/api'
import { takePendingAsk, useDesktopState } from '../lib/desktopStore'
import { navigate } from '../lib/router'
import { consumeSse } from '../lib/sse'
import type { ApiStatus } from '../types'
import './connected.css'

type ChatLine = Pick<AIMessage, 'id' | 'role' | 'content'>
export function AiView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [message, setMessage] = useState('')
  const [providers, setProviders] = useState<readonly AIProvider[]>([])
  const [providerId, setProviderId] = useState('')
  const [conversations, setConversations] = useState<readonly AIConversation[]>([])
  const [conversationId, setConversationId] = useState('')
  const [lines, setLines] = useState<readonly ChatLine[]>([])
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [partial, setPartial] = useState('')
  const [notice, setNotice] = useState('')
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
  return <div className="connected-workspace">
    <div className="connected-toolbar"><ApiStatusPill status={apiStatus} /><label>Provider<select aria-label="Chat provider" value={providerId} disabled={running} onChange={(event) => setProviderId(event.target.value)}>{!providers.length && <option value="">Configure a provider</option>}{providers.map((item) => <option key={item.id} value={item.id}>{item.kind} · {String(item.model_policy?.default_model ?? 'auto')}</option>)}</select></label><button className="button button--quiet" onClick={() => navigate('/settings')}>AI settings</button><button className="button button--primary" disabled={running} onClick={() => { setConversationId(''); setLines([]); setPartial(''); setNotice('') }}>New chat</button></div>
    <div className="connected-columns"><aside className="connected-card connected-list" aria-label="Conversations">{conversations.map((item) => <button disabled={running || loading} className={item.id === conversationId ? 'connected-selected' : ''} key={item.id} onClick={() => setConversationId(item.id)}>{item.title}</button>)}{!conversations.length && <p>No conversations yet.</p>}</aside>
      <section className="connected-card chat-content" aria-label="AI conversation"><div className="chat-lines" aria-live="polite">{lines.map((line) => <article key={line.id} className={`chat-line chat-line--${line.role}`}><strong>{line.role === 'user' ? 'You' : 'Aelys'}</strong><div>{line.content}</div></article>)}{partial && <article className="chat-line"><strong>Aelys</strong><div>{partial}</div></article>}{!lines.length && !partial && <p>{loading ? 'Loading conversation…' : 'Choose a provider in Settings, then ask Aelys.'}</p>}</div>
        {notice && <p role="status">{notice}</p>}
        <form className="connected-compose" onSubmit={submit}><textarea aria-label="Message Aelys" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask Aelys…" disabled={running || loading} /><button className="button button--primary" type="submit" disabled={running || loading || !message.trim() || !providerId || apiStatus !== 'ready'}>{running ? 'Responding…' : 'Send'}</button>{running && <button type="button" className="button button--quiet" onClick={() => void cancel()}>Stop</button>}</form>
      </section></div>
  </div>
}
