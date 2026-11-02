import { useState } from 'react'
import { LayoutGrid, Plus, RotateCcw, X } from '../../icons'
import { navigate } from '../../lib/router'
import { AddWidgetSheet } from '../desktop/AddWidgetSheet'
import { MOBILE_DEFAULT_LAYOUT, WIDGET_CATALOG, layoutKey, newLayoutEntry, pendingHighlight, readLayout, saveLayout, type LayoutEntry } from '../desktop/homeLayout'
import '../mobile-customize.css'

/** Mobile Customize: the shell title says "Customize home"; this lists the cards on Home and adds more from a bottom sheet. */
export function CustomizeMobile() {
  const [layout, setLayout] = useState<LayoutEntry[]>(() => readLayout(true))
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState('')
  const save = (next: LayoutEntry[]) => {
    if (!saveLayout(next, true)) { setNotice('Could not save. Allow local storage and try again.'); return false }
    setLayout(next); setNotice(''); return true
  }
  return <div className="customize-m">
    {notice && <p role="status" className="customize-m__notice">{notice}</p>}
    <section className="customize-m__section" aria-labelledby="customize-mine">
      <div className="customize-m__head">
        <div><h2 id="customize-mine">My widgets</h2><p>{layout.length} on home</p></div>
        <button type="button" className="customize-m__reset" onClick={() => save(MOBILE_DEFAULT_LAYOUT.map(entry => [...entry] as LayoutEntry))}><RotateCcw size={16} aria-hidden="true" />Reset</button>
      </div>
      <ul className="customize-m__list">
        {layout.map(entry => {
          const [id] = entry
          const key = layoutKey(entry)
          const { title, icon: Icon } = WIDGET_CATALOG[id]
          return <li key={key} className="customize-m__row">
            <span className="customize-m__icon"><Icon size={18} aria-hidden="true" /></span>
            <span className="customize-m__name">{title}</span>
            <button type="button" className="customize-m__remove" aria-label={`Remove ${title}`} onClick={() => save(layout.filter(item => layoutKey(item) !== key))}><X size={18} aria-hidden="true" /></button>
          </li>
        })}
      </ul>
    </section>
    <button type="button" className="customize-m__add" aria-haspopup="dialog" onClick={() => setAdding(true)}><Plus size={18} aria-hidden="true" />Add widget</button>
    {adding && <AddWidgetSheet layout={layout} onClose={() => setAdding(false)} onAdd={(id, size) => {
      const entry = newLayoutEntry(id, size, layout)
      if (!save([...layout, entry])) return
      pendingHighlight.key = layoutKey(entry)
      navigate('/')
    }} />}
  </div>
}
