import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { MemoryFactKind, OwnerMemoryFact } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import { SelectField } from '../components/controls/SelectionControls'

const sourceLabels: Record<string, string> = { api: 'Settings', telegram: 'Telegram', telegram_ai: 'Telegram assistant' }
const sourceLabel = (source: string) => sourceLabels[source] ?? source

const localInput = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
export function MemorySettings() {
  const [facts, setFacts] = useState<readonly OwnerMemoryFact[]>([])
  const [editing, setEditing] = useState<OwnerMemoryFact | null>(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryFactKind>('fact')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const load = useCallback(async (search = '') => {
    try { setFacts(await getSharedApiClient().ownerMemory(search || undefined)) }
    catch { setNotice('Could not load memory. Check your owner session and connection.') }
  }, [])
  useEffect(() => { void load() }, [load])
  const reset = () => { setEditing(null); setText(''); setKind('fact'); setExpires('') }
  const edit = (fact: OwnerMemoryFact) => { setEditing(fact); setText(fact.text); setKind(fact.kind); setExpires(localInput(fact.expires_at)); setNotice('') }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !text.trim()) return
    setBusy(true); setNotice('')
    try {
      const body = { text: text.trim(), kind, expires_at: expires ? new Date(expires).toISOString() : null }
      if (editing) await getSharedApiClient().updateMemoryFact(editing.id, { ...body, version: editing.version })
      else await getSharedApiClient().rememberFact(body)
      reset(); await load(query); setNotice('Fact saved.')
    } catch (error) { setNotice(error instanceof ApiError && error.status === 409 ? 'This fact changed. Refresh and review it before editing again.' : 'Could not save the fact. Your text is still here; check the connection and retry.') }
    finally { setBusy(false) }
  }
  const forget = async (fact: OwnerMemoryFact) => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      await getSharedApiClient().forgetMemoryFact(fact.id, fact.version)
      setFacts(items => items.filter(item => item.id !== fact.id)); if (editing?.id === fact.id) reset()
      await load(query); setNotice('Fact forgotten.')
    } catch (error) { setNotice(error instanceof ApiError && error.status === 409 ? 'This fact changed. Refresh and review it before forgetting.' : 'Could not forget the fact. Check the connection and retry.') }
    finally { setBusy(false) }
  }
  return <div className="page page--settings actual-settings-forms"><div className="settings-grid">
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>Memory</h2><p>Only facts you explicitly save. Expired and forgotten facts are excluded from your assistant’s context.</p></div></div>
      {notice && <p role="status">{notice}</p>}
      <label className="settings-form">Search saved facts<input maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button className="button button--quiet" disabled={busy} onClick={() => void load(query)}>Refresh</button>
      {!facts.length && <p className="actual-settings-empty">No saved facts yet.</p>}
      {facts.map(fact => <article className="provider-row" key={fact.id}>
        <strong>{fact.kind}</strong><p>{fact.text}</p>
        <p>{fact.expires_at ? `Expires ${new Date(fact.expires_at).toLocaleString()}` : 'No expiry'} · {sourceLabel(fact.source)}</p>
        <div className="provider-actions"><button className="button button--quiet" disabled={busy} onClick={() => edit(fact)}>Edit</button><button className="button button--quiet" disabled={busy} onClick={() => void forget(fact)}>Forget</button></div>
      </article>)}
    </section>
    <section className="settings-card"><h2>{editing ? 'Edit fact' : 'Save a fact'}</h2>
      <form className="settings-form" onSubmit={save}>
        <label>Fact<textarea required maxLength={2000} value={text} onChange={event => setText(event.target.value)} /></label>
        <SelectField label="Kind" value={kind} disabled={busy} onChange={value => setKind(value as MemoryFactKind)} options={[{value:'fact',label:'Fact'},{value:'preference',label:'Preference'},{value:'goal',label:'Goal'},{value:'context',label:'Context'}]} />
        <label>Expiry (your local time, optional)<input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label>
        <button className="button button--primary" disabled={busy || !text.trim()} type="submit">{busy ? 'Saving…' : 'Save fact'}</button>
        {editing && <button className="button button--quiet" disabled={busy} type="button" onClick={reset}>Cancel editing</button>}
      </form>
    </section>
  </div></div>
}
