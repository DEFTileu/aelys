import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AIProvider, AIProviderKind, JsonObject } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import { Checkbox, SelectField } from '../components/controls/SelectionControls'

const configuredModels = (provider?: AIProvider): JsonObject[] => Array.isArray(provider?.model_policy?.models) ? provider.model_policy.models.filter((item): item is JsonObject => !!item && typeof item === 'object' && !Array.isArray(item)) : []

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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    try { setProviders(await getSharedApiClient().aiProviders()) }
    catch { setNotice('Open your owner session in Connection to manage AI providers.') }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    setBusy(true); setNotice('')
    try {
      const client = getSharedApiClient()
      const current = providers.find((item) => item.id === editing)
      const existingModels = configuredModels(current)
      const previous = existingModels.find(item => item.name === String(current?.model_policy?.default_model ?? model.trim()))
      const capabilities = [...(Array.isArray(previous?.capabilities) ? previous.capabilities.filter(value => typeof value === 'string' && !['streaming', 'tool_calling', 'images', 'documents'].includes(value)) : []), 'streaming', ...(toolCalling ? ['tool_calling'] : []), ...(images ? ['images'] : []), ...(documents ? ['documents'] : [])]
      const modelPolicy = { ...current?.model_policy, ...(kind === 'transcription' ? { monthly_budget: monthlyBudget, transcription_request_cost: transcriptionCost } : {}), default_model: model.trim(), models: kind === 'transcription' ? [] : [...existingModels.filter(item => item !== previous && item.name !== model.trim()), { ...previous, name: model.trim(), capabilities, context_tokens: previous?.context_tokens ?? 100000 }] }
      const provider = editing ? { id: editing } : await client.createAIProvider({ kind, enabled: false, model_policy: modelPolicy }, { queueOnOffline: false })
      // Retain the new id if storing its key fails, so retry edits the same provider.
      setEditing(provider.id)
      if (apiKey) await client.setAIProviderSecret(provider.id, { api_key: apiKey })
      await client.updateAIProvider(provider.id, { model_policy: modelPolicy, enabled: true })
      setNotice(kind === 'transcription' ? 'Transcription saved. You can send voice messages to your Telegram bot.' : 'Provider saved. Test its key, then open AI Chat.'); await load()
    } catch { setNotice('Could not save provider. Check the connection and owner session, then retry.') }
    finally { setApiKey(''); setBusy(false) }
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
    setModel(modelId); setApiKey(''); setNotice('')
  }
  return <div className="page page--settings actual-settings-forms"><div className="settings-grid">
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>AI &amp; models</h2><p>Choose a chat or transcription provider and enter the model ID available to your account. Keys are encrypted on your Aelys backend.</p></div></div>
      {notice && <p role="status">{notice}</p>}
      {!providers.length && <p className="actual-settings-empty">No providers added yet.</p>}
      {providers.map((provider) => <article className="provider-row" key={provider.id}>
        <strong>{provider.kind} · {String(provider.model_policy?.default_model ?? 'Model not set')}</strong>
        <p>{provider.enabled ? 'Enabled' : 'Disabled'} · {provider.has_secret ? 'Key stored' : 'Key required'}</p>
        <div className="provider-actions">
          <button className="button button--quiet" disabled={busy} onClick={() => edit(provider)}>Edit</button>
          <button className="button button--quiet" disabled={busy || !provider.has_secret} onClick={() => void action(async () => {
            const result = await getSharedApiClient().probeAIProvider(provider.id)
            if (!result.connected) throw new Error(result.code)
          }, 'Provider accepted the API key. Model access is checked when sending a message.')}>Test connection</button>
          <button className="button button--quiet" disabled={busy} onClick={() => void action(() => getSharedApiClient().updateAIProvider(provider.id, { enabled: !provider.enabled }), provider.enabled ? 'Provider disabled.' : 'Provider enabled.')}>{provider.enabled ? 'Disable' : 'Enable'}</button>
          <button className="button button--quiet" disabled={busy || !provider.has_secret} onClick={() => void action(() => getSharedApiClient().deleteAIProviderSecret(provider.id), 'Stored API key removed.')}>Remove key</button>
        </div>
      </article>)}
      <button className="button button--quiet" disabled={busy} onClick={() => edit()}>Add provider</button>
    </section>
    <section className="settings-card">
      <h2>{editing ? 'Edit provider' : 'Add provider'}</h2>
      <form className="settings-form" onSubmit={save}>
        <SelectField label="Provider" value={kind} disabled={!!editing || busy} onChange={(value) => setKind(value as AIProviderKind)} options={[{ value: 'claude', label: 'Claude' }, { value: 'openrouter', label: 'OpenRouter' }, { value: 'transcription', label: 'Transcription (OpenAI compatible)' }]} />
        <label>Model ID<input required value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" placeholder="Model ID from your provider" /></label>
        {kind !== 'transcription' ? <div role="group" aria-label="Model capabilities"><strong>Model capabilities</strong><p>Enable only features supported by this model.</p>
          <Checkbox label="Tool calling" checked={toolCalling} disabled={busy} onChange={setToolCalling} />
          <Checkbox label="Images" checked={images} disabled={busy} onChange={setImages} />
          <Checkbox label="PDF documents" checked={documents} disabled={busy} onChange={setDocuments} />
        </div> : <div><p>A separate key for voice transcription through the OpenAI audio API. It is not used for chat replies.</p>
          <label>Monthly transcription budget (USD)<input type="number" min="0" step="0.01" required value={monthlyBudget} onChange={event => setMonthlyBudget(event.target.value)} /></label>
          <label>Estimate per transcription (USD)<input type="number" min="0.01" step="0.01" required value={transcriptionCost} onChange={event => setTranscriptionCost(event.target.value)} /></label>
          <p>This estimate counts toward the monthly limit before each attempt, including failed attempts. Check actual charges with your provider.</p>
        </div>}
        <label>{editing ? 'Replace API key (optional)' : 'API key'}<input type="password" autoComplete="off" required={!editing} minLength={8} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
        <button className="button button--primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save provider'}</button>
      </form>
    </section>
  </div></div>
}
