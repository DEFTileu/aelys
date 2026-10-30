import { useEffect, useState } from 'react'
import { Mail, NotebookText, Search, SquareCheck, type AelysIconComponent } from '../icons'
import { StateCard } from '../components/StateCard'
import type { ApiStatus } from '../types'
import { getSharedApiClient } from '../lib/api'
import type { SearchResult } from '@aelys/shared'
import './desktop/module.css'

function kindIcon(kind?: string): AelysIconComponent {
  return kind === 'task' ? SquareCheck : kind === 'mail' ? Mail : NotebookText
}

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
  return <div className="mod-body">
    <label className="mod-search"><Search size={19} aria-hidden="true" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects, notes, tasks…" aria-label="Search Aelys" /></label>
    {state === 'ready' ? <div className="mod-card">{results.map((result) => {
      const KindIcon = kindIcon(result.kind)
      return <article className="mod-row" key={`${result.kind}-${result.id}`}><span className="mod-row__icon"><KindIcon size={17} aria-hidden="true" /></span><span className="mod-row__body"><strong className="mod-row__title">{result.title}</strong><small className="mod-row__meta">{result.kind}</small></span></article>
    })}</div> : state === 'empty' ? <StateCard status="empty" title={query ? `No results for “${query}”` : 'Search is empty'} description={query ? 'No connected source returned a matching record.' : 'Start typing to search connected records.'} /> : <StateCard status={state} title={state === 'loading' ? 'Searching connected sources' : state === 'offline' ? 'Search is offline' : 'Search is unavailable'} description={state === 'loading' ? 'Waiting for the API response.' : state === 'offline' ? 'Search needs a local index or a live connection.' : 'Check the API base URL in Settings.'} />}
  </div>
}
