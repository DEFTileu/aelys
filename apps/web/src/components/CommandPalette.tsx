import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { BookOpen, Calendar, CalendarPlus, Folder, House, Mail, MessageSquareText, NotebookText, Plus, Search, Settings, Sparkles, SquareCheck, SquarePen, Wallet, type AelysIconComponent } from '../icons'
import { askAelys } from '../lib/desktopStore'
import { kindLabels, openSearchUrl, resultUrl, searchKinds, useSearchResults, type SearchKind } from '../lib/searchNavigation'
import type { RoutePath } from '../types'
import '../views/search.css'

type Item = { key: string; label: string; group: string; icon: AelysIconComponent; color: string; kind: string; body: string; run: () => void }
const pages: { label: string; icon: AelysIconComponent; route: RoutePath; color: string }[] = [
  { label: 'Home', icon: House, route: '/', color: 'violet' }, { label: 'AI Chat', icon: MessageSquareText, route: '/ai', color: 'violet' },
  { label: 'Tasks', icon: SquareCheck, route: '/tasks', color: 'blue' }, { label: 'Calendar', icon: Calendar, route: '/calendar', color: 'red' },
  { label: 'Projects', icon: Folder, route: '/projects', color: 'green' }, { label: 'Notes', icon: NotebookText, route: '/notes', color: 'orange' },
  { label: 'Mail', icon: Mail, route: '/mail', color: 'blue' }, { label: 'Finances', icon: Wallet, route: '/finance', color: 'green' },
  { label: 'Knowledge base', icon: BookOpen, route: '/knowledge', color: 'violet' }, { label: 'Settings', icon: Settings, route: '/settings', color: 'gray' },
]
const kindIcons: Record<SearchKind, AelysIconComponent> = { task: SquareCheck, note: NotebookText, mail: Mail }
const kindColors: Record<SearchKind, string> = { task: 'blue', note: 'orange', mail: 'violet' }

export function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (path: RoutePath) => void }) {
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const { results, status } = useSearchResults(query)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; inputRef.current?.focus(); return () => { if (previous?.isConnected) previous.focus() } }, [])
  const needle = query.trim().toLowerCase()
  const items: Item[] = pages.filter(page => !needle || page.label.toLowerCase().includes(needle)).map(page => ({ key: page.route, label: page.label, group: needle ? 'Pages' : 'Go to', icon: page.icon, color: page.color, kind: 'Page', body: `Open ${page.label}.`, run: () => onNavigate(page.route) }))
  for (const kind of searchKinds) for (const result of results.filter(item => item.kind === kind)) items.push({ key: `${kind}-${result.id}`, label: result.title || 'Untitled', group: kindLabels[kind], icon: kindIcons[kind], color: kindColors[kind], kind: kindLabels[kind] === 'Mail' ? 'Email' : kind === 'task' ? 'Task' : 'Note', body: result.snippet || '', run: () => { onClose(); openSearchUrl(resultUrl(result)) } })
  const actions = [
    { label: 'New task', icon: Plus, color: 'blue', url: '/tasks?create=1' },
    { label: 'New note', icon: SquarePen, color: 'orange', url: '/notes?create=1' },
    { label: 'Create event', icon: CalendarPlus, color: 'red', url: '/calendar?create=1' },
  ]
  for (const action of actions.filter(item => !needle || item.label.toLowerCase().includes(needle))) items.push({ key: action.url, label: action.label, group: 'Actions', icon: action.icon, color: action.color, kind: 'Action', body: `Open the ${action.label.toLowerCase()} form.`, run: () => { onClose(); openSearchUrl(action.url) } })
  if (needle) items.push({ key: 'ask', label: `Ask Aelys “${query.trim()}”`, group: 'Ask Aelys', icon: Sparkles, color: 'violet', kind: 'AI', body: 'Continue in AI Chat.', run: () => { onClose(); askAelys(query.trim()) } })
  const selected = Math.min(selection, items.length - 1)
  const current = items[selected]
  const groups = [...new Set(items.map(item => item.group))]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelection(Math.max(0, Math.min(items.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)))) }
    else if (event.key === 'Enter' && event.target === inputRef.current && current) { event.preventDefault(); if (event.metaKey || event.ctrlKey) { onClose(); askAelys(query.trim()) } else current.run() }
    else if (event.key === 'Tab') {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])]
      if (!focusable.length) return
      const index = focusable.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable[focusable.length - 1].focus() }
      else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0].focus() }
    }
  }
  return <div className="actual-search-overlay" onClick={onClose}>
    <div ref={dialogRef} className="actual-palette" role="dialog" aria-modal="true" aria-label="Search" onClick={event => event.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="actual-palette__input"><Search size={24} /><input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setSelection(0) }} placeholder="Aelys Search" aria-label="Search everything" />{needle && <span>{results.length} results</span>}</div>
      <div className="actual-palette__content"><div className="actual-palette__list" role="listbox" aria-label="Search results and commands">
        {groups.map(group => <div key={group} role="group" aria-label={group}><div className="actual-palette__group">{group}</div>{items.filter(item => item.group === group).map(item => { const index = items.indexOf(item); return <button key={item.key} type="button" role="option" aria-selected={index === selected} className={`actual-search-row${index === selected ? ' is-selected' : ''}`} onMouseEnter={() => setSelection(index)} onClick={item.run}><span className={`actual-search-icon ${item.color}`}><item.icon size={16} /></span><span className="actual-search-row__title">{item.label}</span><span className="actual-search-row__hint">{item.kind}</span></button> })}</div>)}
        {status === 'loading' && <p className="actual-search-message">Searching…</p>}{status === 'error' && <p className="actual-search-message" role="status">Search unavailable. Try again.</p>}
      </div><div className="actual-palette__preview">{current && <><span className={`actual-search-icon actual-search-icon--large ${current.color}`}><current.icon size={28} /></span><strong>{current.label}</strong><small>{current.kind}</small>{current.body && <p>{current.body}</p>}<button type="button" onClick={current.run}>{current.kind === 'Action' ? 'Run' : current.kind === 'AI' ? 'Ask' : 'Open'} <span>↵</span></button></>}</div></div>
      <div className="actual-palette__footer">↑↓ Navigate <span>↵ Open</span><span>Esc Close</span></div>
    </div>
  </div>
}
