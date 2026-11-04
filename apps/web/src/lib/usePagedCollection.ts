import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ApiError, type Query, type ReadPage, type RequestOptions } from '@aelys/shared'
import type { ApiStatus } from '../types'

type Source = 'loading' | 'cached' | 'live' | 'error' | 'auth'
type PageReader<T> = (query: Query, options: RequestOptions) => Promise<ReadPage<T>>

/** Cached previews are provisional; only validated pages enable online writes. */
export function usePagedCollection<T extends { id: string }>(apiStatus: ApiStatus, query: Query, read: PageReader<T>) {
  const [items, setItems] = useState<readonly T[]>([])
  const [source, setSource] = useState<Source>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [facets, setFacets] = useState<ReadPage<T>['facets']>(null)
  const generation = useRef(0)
  const pageCount = useRef(1)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const current = useRef({ query, read, apiStatus, nextCursor })
  current.current = { query, read, apiStatus, nextCursor }
  const queryKey = JSON.stringify(query)
  const previousFilter = useRef({ queryKey, read })
  const merge = (pages: readonly ReadPage<T>[]) => [...new Map(pages.flatMap(page => page.items).map(item => [item.id, item])).values()]

  const refresh = useCallback(async (forceRefresh = true, more = false) => {
    const run = ++generation.current
    const { query: filters, read: fetchPage, nextCursor: next, apiStatus: status } = current.current
    if (more && !next) return
    setRefreshing(true)
    let cursor = more ? next : null
    let cached = status !== 'ready'
    const pages: ReadPage<T>[] = []
    try {
      const count = more ? 1 : pageCount.current
      for (let index = 0; index < count; index += 1) {
        const params = { ...filters, limit: 50, ...(cursor ? { cursor } : {}) }
        const preview = (value: unknown) => {
          if (run !== generation.current || more || index !== 0) return
          const page = value as ReadPage<T>
          setItems(existing => existing.length ? existing : page.items)
          setSource('cached')
          if (page.facets) setFacets(page.facets)
        }
        let page: ReadPage<T>
        try { page = await fetchPage(params, { forceRefresh, cacheOnly: status !== 'ready', allowCacheFallback: false, onCached: preview }) }
        catch (error) {
          if (error instanceof ApiError && [401, 403].includes(error.status)) throw error
          if (error instanceof ApiError && error.status < 500) throw error
          page = await fetchPage(params, { cacheOnly: true })
          cached = true
        }
        if (run !== generation.current) return
        pages.push(page)
        cursor = page.next_cursor
        if (!cursor) break
      }
      if (run !== generation.current) return
      const values = merge(pages)
      setItems(existing => {
        const prior = new Map(existing.map(item => [item.id, item]))
        const validated = values.map(item => {
          const old = prior.get(item.id)
          const before = (old as { version?: number } | undefined)?.version
          const after = (item as { version?: number }).version
          return old && before !== undefined && after !== undefined && before > after ? old : item
        })
        return more ? [...new Map([...existing, ...validated].map(item => [item.id, item])).values()] : validated
      })
      pageCount.current = more ? pageCount.current + 1 : pages.length
      setNextCursor(cursor)
      if (!more) setFacets(pages[0]?.facets ?? null)
      setSource(cached ? 'cached' : 'live')
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        generation.current += 1; setItems([]); setFacets(null); setNextCursor(null); setSource('auth'); setRefreshing(false)
      } else if (run === generation.current) setSource('error')
    } finally { if (run === generation.current) setRefreshing(false) }
  }, [])

  useEffect(() => {
    if (apiStatus !== 'ready' && itemsRef.current.length) {
      generation.current += 1; setSource('cached'); setRefreshing(false)
      return
    }
    if (previousFilter.current.queryKey !== queryKey || previousFilter.current.read !== read) {
      pageCount.current = 1
      setNextCursor(null)
      previousFilter.current = { queryKey, read }
    }
    void refresh(false)
    return () => { generation.current += 1 }
  }, [queryKey, apiStatus, read, refresh])
  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden' && current.current.apiStatus === 'ready') void refresh(false) }
    const timer = window.setInterval(resume, 60_000)
    window.addEventListener('focus', resume); window.addEventListener('online', resume)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('online', resume) }
  }, [refresh])

  // A confirmed local mutation wins over any in-flight refresh snapshot.
  const updateItems: Dispatch<SetStateAction<readonly T[]>> = useCallback(update => {
    generation.current += 1
    setRefreshing(false)
    setItems(update)
  }, [])
  return { items, setItems: updateItems, source, refreshing, nextCursor, facets, refresh, loadMore: () => refresh(false, true) }
}

export function useDebouncedQuery(value: string) {
  const [query, setQuery] = useState(value.trim())
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(value.trim()), 200)
    return () => window.clearTimeout(timer)
  }, [value])
  return query
}
