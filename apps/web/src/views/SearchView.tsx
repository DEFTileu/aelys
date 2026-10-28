import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { StateCard } from '../components/StateCard'
import type { ApiStatus } from '../types'
import { getSharedApiClient } from '../lib/api'
import type { SearchResult } from '@aelys/shared'

export function SearchView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<ApiStatus>(apiStatus === 'ready' ? 'empty' : apiStatus)
  const [results, setResults] = useState<readonly SearchResult[]>([])
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) { setResults([]); setState(apiStatus === 'ready' ? 'empty' : apiStatus); return }
    if (apiStatus !== 'ready') { setState(apiStatus); return }
    let active = true
    setState('loading')
    const timer = window.setTimeout(() => { void getSharedApiClient().search(trimmed).then((response) => { if (active) { setResults(response.results); setState(response.results.length ? 'ready' : 'empty') } }).catch(() => { if (active) setState(navigator.onLine ? 'error' : 'offline') }) }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [apiStatus, query])
  return <div className="page"><header className="page-header"><div className="page-header__title"><span className="page-icon"><Icon name="search" size={21} /></span><div><p className="eyebrow">Across Aelys</p><h1>Search</h1><p>Find only records returned by connected, permitted sources.</p></div></div></header><label className="search-field search-field--large"><Icon name="search" size={19} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects, notes, tasks…" aria-label="Search Aelys" /></label><section className="search-results">{state === 'ready' ? <div className="search-result-list">{results.map((result) => <article className="record-row" key={`${result.kind}-${result.id}`}><span className="record-row__icon"><Icon name={result.kind === 'task' ? 'check-square' : result.kind === 'mail' ? 'mail' : 'note'} size={16} /></span><span className="record-row__body"><strong>{result.title}</strong><small>{result.kind}</small></span></article>)}</div> : state === 'empty' ? <StateCard status="empty" title={query ? `No results for “${query}”` : 'Search is empty'} description={query ? 'No connected source returned a matching record.' : 'Start typing to search connected records.'} /> : <StateCard status={state} title={state === 'loading' ? 'Searching connected sources' : state === 'offline' ? 'Search is offline' : 'Search is unavailable'} description={state === 'loading' ? 'Waiting for the API response.' : state === 'offline' ? 'Search needs a local index or a live connection.' : 'Check the API base URL in Settings.'} />}</section></div>
}
