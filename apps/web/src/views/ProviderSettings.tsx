import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AIProvider, AIProviderKind, JsonObject } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import { Checkbox } from '../components/controls/SelectionControls'
import { Lock, Plus } from '../icons'
import { Card, Group } from './settings/ui'
import { AiFeatureDefaults } from './AiFeatureDefaults'

const configuredModels = (provider?: AIProvider): JsonObject[] => Array.isArray(provider?.model_policy?.models) ? provider.model_policy.models.filter((item): item is JsonObject => !!item && typeof item === 'object' && !Array.isArray(item)) : []

// Provider logos follow the design: a lettered tile tinted per provider.
const LOOKS: Record<string, { name: string; letter: string; tone: string; hint: string; models: string[] }> = {
  claude: { name: 'Claude', letter: 'C', tone: 'st-tone-claude', hint: 'Anthropic models', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
  openrouter: { name: 'OpenRouter', letter: 'O', tone: 'st-tone-profile', hint: 'Many models, one key', models: [] },
  transcription: { name: 'Transcription', letter: 'T', tone: 'st-tone-blue', hint: 'Voice messages, OpenAI compatible', models: ['gpt-4o-mini-transcribe', 'whisper-1'] },
}
const KINDS: AIProviderKind[] = ['claude', 'openrouter', 'transcription']

const errorCode = (error: unknown) => { const code = (error as { code?: unknown })?.code; return typeof code === 'string' ? ` (${code})` : '' }

export function ProviderSettings() {
  const [providers, setProviders] = useState<readonly AIProvider[]>([])
  const [editing, setEditing] = useState<string>('')
  const [kind, setKind] = useState<AIProviderKind>('claude')
  const [model, setModel] = useState('')
  const [toolCalling, setToolCalling] = useState(false)
  const [images, setImages] = useState(false)
  const [documents, setDocuments] = useState(false)
  const [monthlyBudget, setMonthlyBudget] = useState('100')
  const [transcriptionCost, setTranscriptionCost] = useState('0.10')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<{ field: 'model' | 'key'; text: string } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const load = useCallback(async () => {
    try { setProviders(await getSharedApiClient().aiProviders()) }
    catch { setNotice('Open your owner session in Connection to manage AI providers.') }
  }, [])
  useEffect(() => { void load() }, [load])
  const current = providers.find((item) => item.id === editing)
  const keyRequired = !current?.has_secret

  /** Validates in the page (native bubbles are silent in the app webviews), stores the provider and returns its id. */
  const persist = async (): Promise<string | undefined> => {
    setProblem(null)
    if (!model.trim()) { setProblem({ field: 'model', text: 'Enter the model ID your provider uses.' }); return undefined }
    if (keyRequired && apiKey.trim().length < 8) { setProblem({ field: 'key', text: 'Paste the provider API key (at least 8 characters) to save this provider.' }); return undefined }
    const client = getSharedApiClient()
    const existingModels = configuredModels(current)
    const previous = existingModels.find(item => item.name === String(current?.model_policy?.default_model ?? model.trim()))
    const capabilities = [...(Array.isArray(previous?.capabilities) ? previous.capabilities.filter(value => typeof value === 'string' && !['streaming', 'tool_calling', 'images', 'documents'].includes(value)) : []), 'streaming', ...(toolCalling ? ['tool_calling'] : []), ...(images ? ['images'] : []), ...(documents ? ['documents'] : [])]
    const modelPolicy = { ...current?.model_policy, ...(kind === 'transcription' ? { monthly_budget: monthlyBudget, transcription_request_cost: transcriptionCost } : {}), default_model: model.trim(), models: kind === 'transcription' ? [] : [...existingModels.filter(item => item !== previous && item.name !== model.trim()), { ...previous, name: model.trim(), capabilities, context_tokens: previous?.context_tokens ?? 100000 }] }
    const provider = editing ? { id: editing } : await client.createAIProvider({ kind, enabled: false, model_policy: modelPolicy }, { queueOnOffline: false })
    // Retain the new id if storing its key fails, so retry edits the same provider.
    setEditing(provider.id)
    if (apiKey) await client.setAIProviderSecret(provider.id, { api_key: apiKey })
    await client.updateAIProvider(provider.id, { model_policy: modelPolicy, enabled: true })
    return provider.id
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    setBusy(true); setNotice('')
    try {
      const id = await persist()
      if (id) { setNotice(kind === 'transcription' ? 'Transcription saved. You can send voice messages to your Telegram bot.' : 'Provider saved. Test the connection, then open AI Chat.'); await load() }
    } catch (error) { console.debug('[aelys] save provider failed', error); setNotice(`Could not save provider${errorCode(error)}. Check the connection and owner session, then retry.`) }
    finally { setApiKey(''); setBusy(false) }
  }
  const test = async () => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      // A freshly typed key (or a provider that was never saved) is stored first, so the test always uses what is on screen.
      const id = apiKey || !current ? await persist() : current.id
      if (!id) return
      setApiKey('')
      const result = await getSharedApiClient().probeAIProvider(id)
      setNotice(result.connected ? 'Connected: the provider accepted the API key. Model access is checked when you send a message.' : `The provider rejected the request (${result.code}). Check the key and model ID.`)
      await load()
    } catch (error) { console.debug('[aelys] provider test failed', error); setNotice(`Could not reach the provider test${errorCode(error)}. Check your connection and owner session, then retry.`) }
    finally { setBusy(false) }
  }
  const action = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true); setNotice('')
    try { await work(); setNotice(message); await load() }
    catch { setNotice('Provider request failed. Check your owner session and connection.') }
    finally { setBusy(false) }
  }
  const edit = (provider?: AIProvider) => {
    setEditing(provider?.id ?? ''); setKind(provider?.kind ?? 'claude')
    setMonthlyBudget(String(provider?.model_policy?.monthly_budget ?? '100')); setTranscriptionCost(String(provider?.model_policy?.transcription_request_cost ?? '0.10'))
    const modelId = String(provider?.model_policy?.default_model ?? '')
    const capabilities = configuredModels(provider).find(item => item.name === modelId)?.capabilities
    setToolCalling(Array.isArray(capabilities) && capabilities.includes('tool_calling'))
    setImages(Array.isArray(capabilities) && capabilities.includes('images')); setDocuments(Array.isArray(capabilities) && capabilities.includes('documents'))
    setModel(modelId); setApiKey(''); setShowKey(false); setProblem(null); setNotice(''); setFormOpen(true)
  }
  const showForm = formOpen || !providers.length
  const look = LOOKS[kind] ?? LOOKS.claude
  return <>
    <Group title="Providers">
      <Card>
        {providers.map((provider) => { const item = LOOKS[provider.kind] ?? LOOKS.claude; return <div className="st-prov" key={provider.id}>
          <span className={`st-prov-logo ${item.tone}`}>{item.letter}</span>
          <div className="st-grow">
            <div className="st-prov-name">{item.name}{!provider.enabled && <span className="st-chip st-chip--off">Disabled</span>}</div>
            <div className="st-prov-model st-mono">{String(provider.model_policy?.default_model ?? 'Model not set')}</div>
          </div>
          <span className={`st-prov-key st-prov-key--${provider.has_secret ? 'ok' : 'missing'}`}>{provider.has_secret ? 'Key stored' : 'Key required'}</span>
          <button type="button" className="st-btn st-btn--34" disabled={busy} onClick={() => edit(provider)}>{provider.has_secret ? 'Edit' : 'Add key'}</button>
        </div> })}
        {!providers.length && <div className="st-empty">No providers added yet.</div>}
        <button type="button" className="st-add" disabled={busy} onClick={() => edit()}><Plus size={14} aria-hidden="true" />Add provider</button>
      </Card>
    </Group>
    {notice && <div className="st-note" role="status">{notice}</div>}
    <AiFeatureDefaults providers={providers} />
    {showForm && <Group title={editing ? 'Edit provider' : 'Add provider'}>
      <Card>
        <form className="st-form" onSubmit={save} noValidate>
          <div role="radiogroup" aria-label="Provider" className="st-kinds">
            {KINDS.map((value) => { const item = LOOKS[value]; return <button key={value} type="button" role="radio" aria-checked={kind === value} className="st-kind" disabled={!!editing || busy} onClick={() => { setKind(value); setModel(''); setProblem(null) }}>
              <span className={`st-prov-logo ${item.tone}`}>{item.letter}</span>
              <span className="st-kind-text"><b>{item.name}</b><span>{item.hint}</span></span>
            </button> })}
          </div>
          <label className="st-field-label">Model ID<input className="st-input st-input--mono" value={model} onChange={(event) => { setModel(event.target.value); setProblem(null) }} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={kind === 'openrouter' ? 'e.g. anthropic/claude-sonnet-5-5' : 'Model ID from your provider'} aria-invalid={problem?.field === 'model'} /></label>
          {look.models.length > 0 && <div className="st-suggest" aria-label="Suggested models">{look.models.map((id) => <button key={id} type="button" className={`st-suggest-chip${model === id ? ' is-on' : ''}`} disabled={busy} onClick={() => { setModel(id); setProblem(null) }}>{id}</button>)}</div>}
          {problem?.field === 'model' && <div className="st-error" role="alert">{problem.text}</div>}
          {kind !== 'transcription' ? <div role="group" aria-label="Model capabilities" className="st-form st-form--flush"><div><div className="st-label">Model capabilities</div><div className="st-hint">Enable only features supported by this model.</div></div>
            <Checkbox label="Tool calling" checked={toolCalling} disabled={busy} onChange={setToolCalling} />
            <Checkbox label="Images" checked={images} disabled={busy} onChange={setImages} />
            <Checkbox label="PDF documents" checked={documents} disabled={busy} onChange={setDocuments} />
          </div> : <div className="st-form st-form--flush"><div className="st-hint">A separate key for voice transcription through the OpenAI audio API. It is not used for chat replies.</div>
            <label className="st-field-label">Monthly transcription budget (USD)<input className="st-input" type="number" min="0" step="0.01" value={monthlyBudget} onChange={event => setMonthlyBudget(event.target.value)} /></label>
            <label className="st-field-label">Estimate per transcription (USD)<input className="st-input" type="number" min="0.01" step="0.01" value={transcriptionCost} onChange={event => setTranscriptionCost(event.target.value)} /></label>
            <div className="st-hint">This estimate counts toward the monthly limit before each attempt, including failed attempts. Check actual charges with your provider.</div>
          </div>}
          <label className="st-field-label">{keyRequired ? 'API key' : 'Replace API key (optional)'}
            <span className="st-keyrow"><input className="st-input" type={showKey ? 'text' : 'password'} autoComplete="off" autoCapitalize="off" spellCheck={false} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setProblem(null) }} aria-invalid={problem?.field === 'key'} placeholder={keyRequired ? 'Paste your key' : 'Leave empty to keep the stored key'} />
              <button type="button" className="st-btn st-btn--34" onClick={() => setShowKey((value) => !value)} aria-pressed={showKey}>{showKey ? 'Hide' : 'Show'}</button></span>
          </label>
          {problem?.field === 'key' && <div className="st-error" role="alert">{problem.text}</div>}
          <div className="st-actions">
            <button className="st-btn st-btn--primary" disabled={busy} type="submit">{busy ? 'Working…' : 'Save provider'}</button>
            <button type="button" className="st-btn st-btn--ghost" disabled={busy} onClick={() => void test()}>Test connection</button>
            {current && <>
              <button type="button" className="st-btn st-btn--ghost" disabled={busy} onClick={() => void action(() => getSharedApiClient().updateAIProvider(current.id, { enabled: !current.enabled }), current.enabled ? 'Provider disabled.' : 'Provider enabled.')}>{current.enabled ? 'Disable' : 'Enable'}</button>
              <button type="button" className="st-btn st-btn--danger" disabled={busy || !current.has_secret} onClick={() => void action(() => getSharedApiClient().deleteAIProviderSecret(current.id), 'Stored API key removed.')}>Remove key</button>
            </>}
          </div>
        </form>
      </Card>
    </Group>}
    <div className="st-note"><Lock size={14} aria-hidden="true" />Keys are encrypted on your Aelys backend and never shown again.</div>
  </>
}
