import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Calendar, CalendarPlus, Folder, House, MessageSquareText, NotebookText, Plus, Search, Settings, Sparkles, SquareCheck, SquarePen, type LucideIcon } from 'lucide-react'
import { askAelys } from '../lib/desktopStore'
import type { RoutePath } from '../types'

type PaletteItem = { label: string; icon: LucideIcon; hint: string; route: RoutePath }
type PaletteGroup = { title: string; items: PaletteItem[] }

const GROUPS: PaletteGroup[] = [
  {
    title: 'Go to',
    items: [
      { label: 'Home', icon: House, hint: 'Page', route: '/' },
      { label: 'AI Chat', icon: MessageSquareText, hint: 'Page', route: '/ai' },
      { label: 'Tasks', icon: SquareCheck, hint: 'Page', route: '/tasks' },
      { label: 'Calendar', icon: Calendar, hint: 'Page', route: '/calendar' },
      { label: 'Projects', icon: Folder, hint: 'Page', route: '/projects' },
      { label: 'Notes', icon: NotebookText, hint: 'Page', route: '/notes' },
      { label: 'Settings', icon: Settings, hint: 'Page', route: '/settings' },
    ],
  },
  {
    title: 'Actions',
    items: [
      { label: 'New task', icon: Plus, hint: 'Action', route: '/tasks' },
      { label: 'New note', icon: SquarePen, hint: 'Action', route: '/notes' },
      { label: 'Create event', icon: CalendarPlus, hint: 'Action', route: '/calendar' },
      { label: 'Ask Aelys', icon: Sparkles, hint: 'Action', route: '/ai' },
    ],
  },
]

// Escape is handled by AppShell (window keydown); Cmd/Ctrl+K toggles it there too.
export function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (path: RoutePath) => void }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const needle = query.trim().toLowerCase()
  const groups = GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !needle || item.label.toLowerCase().includes(needle)) }))
    .filter((group) => group.items.length > 0)
  const first = groups[0]?.items[0]

  // Enter runs the highlighted (first) match, or sends the typed text to Aelys when nothing matches.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    if (first) onNavigate(first.route)
    else { onClose(); askAelys(query.trim()) }
  }

  return <div className="palette-overlay" onClick={onClose}>
    <div className="palette-box" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(event) => event.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 56, padding: '0 18px', borderBottom: '1px solid #EFEAE6' }}>
        <Search size={18} color="#625D69" aria-hidden="true" />
        <input ref={inputRef} className="palette-input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Type a command or search…" aria-label="Type a command or search" style={{ flex: 1, fontSize: 16 }} />
        <span aria-hidden="true" style={{ height: 24, padding: '0 8px', borderRadius: 7, background: '#F1EDEA', fontSize: 12, lineHeight: '24px' }}>Esc</span>
      </div>
      <div role="listbox" aria-label="Commands" style={{ padding: 8, maxHeight: 420, overflow: 'auto' }}>
        {groups.map((group) => <div key={group.title} role="group" aria-label={group.title}>
          <div aria-hidden="true" style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#625D69', padding: '10px 12px 6px' }}>{group.title}</div>
          {group.items.map((item) => {
            const active = item === first
            return <button key={item.label} type="button" role="option" aria-selected={active} className={`palette-btn palette-item${active ? ' palette-item--active' : ''}`} onClick={() => onNavigate(item.route)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', height: 40, padding: '0 12px', borderRadius: 10, fontSize: 14 }}>
              <item.icon size={18} color="#3A3640" aria-hidden="true" />
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={{ fontSize: 12, color: '#625D69' }}>{item.hint}</span>
            </button>
          })}
        </div>)}
        {groups.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#625D69' }}>No results — press Enter to ask Aelys</div>}
      </div>
    </div>
  </div>
}
