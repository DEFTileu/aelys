import { useEffect, useRef, useState } from 'react'
import { Plus, Search, X } from '../../icons'
import { accentOf } from '../../data/desktop/home'
import { WIDGET_CATALOG, WIDGET_IDS, type LayoutEntry, type SizeKey, type WidgetId } from './homeLayout'
import './add-widget-sheet.css'

type SheetSize = 'S' | 'M' | 'L' | 'Full'
const same = 'The same card, wider.'
/** What each size shows, matching desktopBodies.tsx. */
const SIZE_NOTES: Record<WidgetId, Record<SheetSize, string>> = {
  today: { S: 'Up to five of today’s tasks with checkboxes.', M: same, L: 'Adds a quick add field and more tasks.', Full: same },
  cal: { S: 'Today’s events as tinted bars.', M: same, L: 'Adds the month grid.', Full: same },
  focus: { S: 'The focus ring with Start, Stop and a shortcut to Timer.', M: 'The ring and its controls side by side.', L: 'Adds the linked task, today’s total and a week chart.', Full: same },
  weather: { S: 'Current conditions and the next hours.', M: same, L: 'Adds the five-day forecast.', Full: same },
  proj: { S: 'Three projects with progress bars.', M: 'Projects in two columns.', L: 'Up to eight projects in two columns.', Full: same },
  notes: { S: 'Your four latest notes.', M: 'Notes in two columns.', L: 'Up to ten notes in two columns.', Full: same },
  fin: { S: 'Balance, the change this week, a seven-day chart and top categories.', M: same, L: 'Adds more categories and your budget.', Full: same },
  kb: { S: 'Your four latest knowledge notes.', M: 'Notes in two columns.', L: 'Up to ten notes in two columns.', Full: same },
  mail: { S: 'Your latest unread messages.', M: 'Messages in two columns.', L: 'Recent messages in two columns.', Full: same },
  activity: { S: 'The latest three events.', M: 'Events in two columns.', L: 'The latest eight events.', Full: 'Four events across the whole row.' },
}
const SIZES: { key: SheetSize; label: string; w: number; h: number }[] = [{ key: 'S', label: 'S', w: 78, h: 78 }, { key: 'M', label: 'M', w: 160, h: 78 }, { key: 'L', label: 'L', w: 160, h: 160 }]
const FULL = { key: 'Full' as const, label: 'Full', w: 240, h: 78 }

export function AddWidgetSheet({ layout, onAdd, onClose, fullScreen = false }: { layout: readonly LayoutEntry[]; onAdd: (id: WidgetId, size: SizeKey) => void; onClose: () => void; fullScreen?: boolean }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<WidgetId>(WIDGET_IDS[0])
  const [picked, setSize] = useState<SheetSize>('M')
  const dialog = useRef<HTMLDivElement>(null)
  const list = WIDGET_IDS.filter(id => `${WIDGET_CATALOG[id].title} ${WIDGET_CATALOG[id].description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const current = list.includes(selected) ? selected : list[0]
  // Full is only offered for Recent activity.
  const size: SheetSize = picked === 'Full' && current !== 'activity' ? 'M' : picked
  const sizes = current === 'activity' ? [FULL, ...SIZES] : SIZES
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('input')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input,[tabindex="0"]')]
        const first = focusable[0]; const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); if (before?.isConnected) before.focus() }
  }, [onClose])
  const def = current ? WIDGET_CATALOG[current] : undefined
  const accent = def ? accentOf(def.color) : undefined
  return <div className={`add-widget-backdrop${fullScreen ? ' add-widget-backdrop--full' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className="add-widget" role="dialog" aria-modal="true" aria-label="Add widget">
      <div className="add-widget__list">
        <label className="add-widget__search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search widgets" aria-label="Search widgets" /></label>
        <div role="listbox" aria-label="Widgets">
          {list.map(id => {
            const item = WIDGET_CATALOG[id]; const { c, soft } = accentOf(item.color)
            return <button key={id} type="button" role="option" aria-selected={id === current} className="add-widget__item" onClick={() => { setSelected(id); if (id === 'activity') setSize('Full') }}>
              <span className="add-widget__icon" style={{ background: soft, color: c }}><item.icon size={16} aria-hidden="true" /></span>
              <span className="add-widget__name">{item.title}</span>
              {layout.some(entry => entry[0] === id) && <small>On Home</small>}
            </button>
          })}
          {!list.length && <p className="add-widget__none">No widgets match.</p>}
        </div>
      </div>
      <div className="add-widget__detail">
        <header><div><h2>{def?.title ?? 'Add widget'}</h2><p>{def?.description}</p></div><button type="button" className="add-widget__close" aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
        <div className="add-widget__sizes" role="radiogroup" aria-label="Size">
          {sizes.map(item => <button key={item.key} type="button" role="radio" aria-checked={size === item.key} className="add-widget__size" onClick={() => setSize(item.key)}>
            <span className="add-widget__preview" style={{ width: item.w, height: item.h }}><i style={{ background: accent?.soft }} /><b /><b /></span>
            <span>{item.label}</span>
          </button>)}
        </div>
        {current && <p className="add-widget__note"><strong>{size} shows:</strong> {SIZE_NOTES[current][size]}</p>}
        <div className="add-widget__actions">
          <button type="button" className="add-widget__cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="add-widget__add" disabled={!current} onClick={() => current && onAdd(current, size)}><Plus size={16} aria-hidden="true" />Add</button>
        </div>
      </div>
    </div>
  </div>
}
