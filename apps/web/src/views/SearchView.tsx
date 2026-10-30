import { useState } from 'react'
import { ChevronRight, Mail, NotebookText, Search, SquareCheck, X, type AelysIconComponent } from '../icons'
import { kindLabels, openSearchUrl, resultUrl, searchKinds, useSearchResults, type SearchKind } from '../lib/searchNavigation'
import type { ApiStatus } from '../types'
import './search.css'

const icons: Record<SearchKind, AelysIconComponent> = { task: SquareCheck, note: NotebookText, mail: Mail }
const colors: Record<SearchKind, string> = { task: 'blue', note: 'orange', mail: 'violet' }

export function SearchView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchKind | 'all'>('all')
  const { results, status } = useSearchResults(query, apiStatus === 'ready')
  const kinds = filter === 'all' ? searchKinds : [filter]
  const visible = results.filter(result => filter === 'all' || result.kind === filter)
  return <div className="actual-search-page">
    <label className="actual-search-page__input"><Search size={20} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Aelys" aria-label="Search Aelys" />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}</label>
    <div className="actual-search-filters" aria-label="Filter search results">{(['all', ...searchKinds] as const).map(kind => <button type="button" key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind === 'all' ? 'All' : kindLabels[kind]}</button>)}</div>
    {apiStatus !== 'ready' ? <p className="actual-search-message">{apiStatus === 'offline' ? 'Search is offline.' : apiStatus === 'loading' ? 'Connecting…' : 'Search is unavailable.'}</p> : !query.trim() ? <p className="actual-search-message">Search tasks, notes and mail.</p> : status === 'loading' ? <p className="actual-search-message" role="status">Searching…</p> : status === 'error' ? <p className="actual-search-message" role="status">Search unavailable. Try again.</p> : visible.length === 0 ? <p className="actual-search-message">No results for “{query.trim()}”.</p> : kinds.map(kind => {
      const entries = visible.filter(result => result.kind === kind)
      const Icon = icons[kind]
      return entries.length ? <section className="actual-search-section" key={kind}><h2>{kindLabels[kind]}</h2><div className="actual-search-section__card">{entries.map(entry => <button type="button" className="actual-search-page__row" key={entry.id} onClick={() => openSearchUrl(resultUrl(entry))}><span className={`actual-search-icon ${colors[kind]}`}><Icon size={17} /></span><span><strong>{entry.title || 'Untitled'}</strong>{entry.snippet && <small>{entry.snippet}</small>}</span><ChevronRight size={16} /></button>)}</div></section> : null
    })}
  </div>
}
