import { useState, type FormEvent } from 'react'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import type { ApiStatus } from '../types'
import { getSharedApiClient } from '../lib/api'
import { ApiError } from '@aelys/shared'

async function consumeSse(response: Response, onEvent: (name: string, data: Record<string, unknown>) => void): Promise<void> {
  if (!response.body) throw new Error('AI stream has no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? 'message'
      const raw = block.match(/^data:\s*(.+)$/m)?.[1]?.trim()
      if (!raw) continue
      try { onEvent(event, JSON.parse(raw) as Record<string, unknown>) } catch { /* ignore malformed provider event */ }
    }
    if (chunk.done) break
  }
}

export function AiView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [message, setMessage] = useState('')
  const [runState, setRunState] = useState<'idle' | 'running' | 'completed' | 'failed' | 'cancelled'>('idle')
  const [runId, setRunId] = useState<string | undefined>()
  const [assistantText, setAssistantText] = useState('')
  const [runMessage, setRunMessage] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const prompt = message.trim()
    if (!prompt || apiStatus !== 'ready') return
    setMessage(''); setAssistantText(''); setRunMessage('Connecting to the configured provider…'); setRunState('running')
    try {
      const client = getSharedApiClient()
      const conversation = await client.createAIConversation({ title: 'Aelys Chat' })
      const idempotencyKey = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `ai-${Date.now()}`
      const run = await client.createAIRun({ conversation_id: conversation.id, message: prompt, idempotency_key: idempotencyKey })
      setRunId(run.id)
      const response = await client.aiRunEvents(run.id)
      await consumeSse(response, (event, data) => {
        if (event === 'ai.text.delta') setAssistantText((value) => value + String(data.text ?? ''))
        if (event === 'ai.run.failed') { setRunState('failed'); setRunMessage(String(data.message ?? data.code ?? 'Provider execution failed')) }
        if (event === 'ai.run.cancelled') { setRunState('cancelled'); setRunMessage('Run cancelled') }
        if (event === 'ai.run.completed') setRunState('completed')
      })
      setRunState((value) => value === 'running' ? 'completed' : value)
      setRunMessage((value) => value === 'Connecting to the configured provider…' ? '' : value)
    } catch (error) {
      setRunState('failed')
      setRunMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'AI request failed')
    }
  }
  const cancel = async () => { if (!runId) return; await getSharedApiClient().cancelAIRun(runId); setRunState('cancelled'); setRunMessage('Run cancelled') }
  return <div className="page page--ai"><header className="page-header"><div className="page-header__title"><span className="page-icon page-icon--ai"><Icon name="sparkles" size={21} /></span><div><p className="eyebrow">Assistant</p><h1>AI Chat</h1><p>Ask questions over connected Aelys data with explicit tool access.</p></div></div><ApiStatusPill status={apiStatus} /></header><section className="ai-chat-surface"><div className="ai-chat-empty"><div className="ai-chat-empty__orb"><Icon name="sparkles" size={27} /></div><h2>{runState === 'idle' ? 'Start with a question' : runState === 'running' ? 'Aelys is thinking' : runState === 'completed' ? 'Response received' : 'Run stopped'}</h2><p>{runMessage || (assistantText || 'Responses stream from the configured backend provider. No answer is fabricated when the provider is unavailable.')}</p>{assistantText && <div className="ai-response" aria-live="polite">{assistantText}</div>}<div className="ai-suggestions"><button onClick={() => setMessage('Plan my day')}><Icon name="calendar" size={15} />Plan my day</button><button onClick={() => setMessage('Find a task')}><Icon name="search" size={15} />Find a task</button><button onClick={() => setMessage('Create a note')}><Icon name="note" size={15} />Create a note</button></div></div><form className="chat-composer" onSubmit={submit}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask Aelys or find something…" aria-label="Message Aelys" disabled={runState === 'running'} /><button className="icon-button icon-button--accent" type="submit" aria-label="Send message" disabled={runState === 'running'}><Icon name="send" size={17} /></button>{runState === 'running' && <button className="button button--quiet" type="button" onClick={() => void cancel()}>Stop</button>}</form></section><StateCard status={apiStatus === 'ready' ? (runState === 'failed' ? 'error' : 'empty') : apiStatus} title={apiStatus === 'ready' ? (runState === 'failed' ? 'AI provider unavailable' : 'Provider connection') : apiStatus === 'offline' ? 'AI is unavailable offline' : 'AI connection is not ready'} description={apiStatus === 'ready' ? 'Configure an approved provider and BYOK secret in the backend before starting a run.' : 'The shell keeps this state explicit and does not simulate an answer.'} /></div>
}
