import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AIProvider, AIProviderKind } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'

export function ProviderSettings() {
  const [providers, setProviders] = useState<readonly AIProvider[]>([])
  const [editing, setEditing] = useState<string>('')
  const [kind, setKind] = useState<AIProviderKind>('claude')
  const [model, setModel] = useState('')
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
      const modelPolicy = { ...current?.model_policy, default_model: model.trim(), models: [{ name: model.trim(), capabilities: ['streaming'], context_tokens: 100000 }] }
      const provider = editing ? { id: editing } : await client.createAIProvider({ kind, enabled: false, model_policy: modelPolicy }, { queueOnOffline: false })
      // Retain the new id if storing its key fails, so retry edits the same provider.
      setEditing(provider.id)
      if (apiKey) await client.setAIProviderSecret(provider.id, { api_key: apiKey })
      await client.updateAIProvider(provider.id, { model_policy: modelPolicy, enabled: true })
      setNotice('Provider saved. Test its key, then open AI Chat.'); await load()
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
    setModel(String(provider?.model_policy?.default_model ?? '')); setApiKey(''); setNotice('')
  }
  return <div className="page page--settings"><div className="settings-grid">
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>AI &amp; models</h2><p>Choose Claude or OpenRouter and enter the model ID available to your account. Keys are encrypted on your Aelys backend.</p></div></div>
      {notice && <p role="status">{notice}</p>}
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
        <label>Provider<select value={kind} disabled={!!editing || busy} onChange={(event) => setKind(event.target.value as AIProviderKind)}><option value="claude">Claude</option><option value="openrouter">OpenRouter</option></select></label>
        <label>Model ID<input required value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" placeholder="Model ID from your provider" /></label>
        <label>{editing ? 'Replace API key (optional)' : 'API key'}<input type="password" autoComplete="off" required={!editing} minLength={8} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
        <button className="button button--primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save provider'}</button>
      </form>
    </section>
  </div></div>
}
