import { useEffect, useRef, useState } from 'react'
import { Plus, Search, X } from '../../icons'
import { accentOf } from '../../data/desktop/home'
import { WIDGET_CATALOG, WIDGET_IDS, type LayoutEntry, type SizeKey, type WidgetId } from './homeLayout'
import './add-widget-sheet.css'

/** What each of S, M and L shows, matching widgetBodies.tsx. */
const SIZE_NOTES: Record<WidgetId, Record<'S' | 'M' | 'L', string>> = {
  today: { S: 'How many tasks are left and which one is next.', M: 'The next four tasks with checkboxes.', L: 'Overdue, Today and Tomorrow groups with a quick add field.' },
  cal: { S: 'The next event with a countdown.', M: 'Today as a timeline with a now line.', L: 'The month grid and today’s agenda.' },
  focus: { S: 'The focus ring and a start button.', M: 'Adds the linked task and a shortcut to Timer.', L: 'Adds today’s sessions, total focus time and a week chart.' },
  weather: { S: 'Current temperature and conditions.', M: 'Adds feels-like, wind and today’s high and low.', L: 'Adds the daily forecast.' },
  proj: { S: 'Progress ring for one project.', M: 'Three projects with progress bars.', L: 'Four projects with progress and the next task.' },
  notes: { S: 'An excerpt of your latest note.', M: 'Your two latest notes as cards.', L: 'Recent notes with excerpts and a New button.' },
  fin: { S: 'Balance and the change this week.', M: 'Adds a seven-day activity chart.', L: 'Adds a breakdown by transaction type.' },
  kb: { S: 'An excerpt of your latest knowledge note.', M: 'Two latest notes as cards.', L: 'Recent notes with excerpts.' },
  mail: { S: 'Recent message count and sender avatars.', M: 'The three latest messages.', L: 'The inbox with message previews.' },
  activity: { S: 'The latest event.', M: 'The last three events.', L: 'The last eight events.' },
}
const SIZES = [{ key: 'S' as const, label: 'S', w: 78, h: 78 }, { key: 'M' as const, label: 'M', w: 160, h: 78 }, { key: 'L' as const, label: 'L', w: 160, h: 160 }]

export function AddWidgetSheet({ layout, onAdd, onClose, fullScreen = false }: { layout: readonly LayoutEntry[]; onAdd: (id: WidgetId, size: SizeKey) => void; onClose: () => void; fullScreen?: boolean }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<WidgetId>(WIDGET_IDS[0])
  const [size, setSize] = useState<'S' | 'M' | 'L'>('M')
  const dialog = useRef<HTMLDivElement>(null)
  const list = WIDGET_IDS.filter(id => `${WIDGET_CATALOG[id].title} ${WIDGET_CATALOG[id].description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const current = list.includes(selected) ? selected : list[0]
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
            return <button key={id} type="button" role="option" aria-selected={id === current} className="add-widget__item" onClick={() => setSelected(id)}>
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
          {SIZES.map(item => <button key={item.key} type="button" role="radio" aria-checked={size === item.key} className="add-widget__size" onClick={() => setSize(item.key)}>
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
