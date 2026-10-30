import { useEffect, useState } from 'react'
import type { SearchResult } from '@aelys/shared'
import { getSharedApiClient } from './api'

export type SearchKind = 'task' | 'note' | 'mail'
export type SearchEntry = { kind: SearchKind; id: string; title: string; snippet?: string | null }
export const searchKinds: SearchKind[] = ['task', 'note', 'mail']
export const kindLabels: Record<SearchKind, string> = { task: 'Tasks', note: 'Notes', mail: 'Mail' }

export function toSearchEntry(result: SearchResult): SearchEntry | null {
  const kind = result.kind ?? result.resource_type
  const id = result.id ?? result.resource_id
  return id && searchKinds.includes(kind as SearchKind) ? { kind: kind as SearchKind, id, title: result.title, snippet: result.snippet } : null
}

export function resultUrl(entry: SearchEntry): string {
  const route = entry.kind === 'task' ? 'tasks' : entry.kind === 'note' ? 'notes' : 'mail'
  return `/${route}?${entry.kind}=${encodeURIComponent(entry.id)}`
}

export function openSearchUrl(url: string) {
  window.history.pushState({}, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useSearchResults(query: string, available = true) {
  const [data, setData] = useState<{ query: string; results: SearchEntry[]; status: 'idle' | 'loading' | 'ready' | 'error' }>({ query: '', results: [], status: 'idle' })
  const trimmed = query.trim()
  useEffect(() => {
    if (!trimmed || !available) { setData({ query: trimmed, results: [], status: 'idle' }); return }
    let active = true
    setData({ query: trimmed, results: [], status: 'loading' })
    const timer = window.setTimeout(() => {
      void getSharedApiClient().search(trimmed).then(response => {
        if (active) setData({ query: trimmed, results: response.results.map(toSearchEntry).filter((item): item is SearchEntry => item !== null), status: 'ready' })
      }).catch(() => { if (active) setData({ query: trimmed, results: [], status: 'error' }) })
    }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [trimmed, available])
  return data.query === trimmed && available ? data : { query: trimmed, results: [], status: trimmed && available ? 'loading' as const : 'idle' as const }
}
