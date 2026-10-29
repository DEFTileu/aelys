import { useEffect, useState } from 'react'
import { ArrowRight, Check, LayoutGrid, Plus, RotateCcw } from 'lucide-react'
import { HOME_CHIPS, accentOf } from '../data/desktop/home'
import { askAelys, takeCustomizeHome, toggleTask, useDesktopState, useWindowWidth } from '../lib/desktopStore'
import type { ApiStatus } from '../types'
import { DEFAULT_LAYOUT, WIDGET_CATALOG, WIDGET_IDS, readLayout, saveLayout, type LayoutEntry, type WidgetId } from './desktop/homeLayout'
import { HomeWidget, useFocusTimer } from './desktop/homeWidgets'

// Orb gradient from the design; the AppShell hero stays outside this view.
const ORB = 'radial-gradient(circle at 32% 28%,#fff 0,rgba(235,225,255,.9) 9%,transparent 28%),radial-gradient(circle at 72% 72%,#FF7AD9 0,transparent 48%),radial-gradient(circle at 24% 72%,#46D2FF 0,transparent 46%),radial-gradient(circle at 50% 50%,#6E4CF5 0,#2A1590 82%)'

// apiStatus is accepted for the route wiring in App.tsx; the design shows demo data, not live API state.
export function HomeView(_props: { apiStatus?: ApiStatus }) {
  const [layout, setLayout] = useState<LayoutEntry[]>(readLayout)
  const [editing, setEditing] = useState(false)
  const [picker, setPicker] = useState(false)
  const { done, customizeHome } = useDesktopState()
  const width = useWindowWidth()
  const cols = width >= 1240 ? 4 : width >= 900 ? 2 : 1
  const [draft, setDraft] = useState('')
  const focus = useFocusTimer()
  // The sidebar Widgets item sets this flag and navigates here.
  useEffect(() => { if (takeCustomizeHome()) setEditing(true) }, [customizeHome])
  const ask = (text: string) => { const value = text.trim(); if (value) { setDraft(''); askAelys(value) } }

  const commit = (next: LayoutEntry[]) => { setLayout(next); saveLayout(next) }
  const onMyDay = layout.map(([id]) => id)
  const available = WIDGET_IDS.filter((id) => !onMyDay.includes(id))
  const addWidget = (id: WidgetId) => {
    commit([...layout.filter(([w]) => w !== 'activity'), [id, 1], ...layout.filter(([w]) => w === 'activity')])
    setPicker(false)
  }
  const moveWidget = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= layout.length) return
    const next = layout.map((entry) => [...entry] as LayoutEntry)
    const moved = next[index]
    next[index] = next[target]
    next[target] = moved
    commit(next)
  }
  const resizeWidget = (index: number) => {
    const next = layout.map((entry) => [...entry] as LayoutEntry)
    next[index][1] = layout[index][1] > 1 ? 1 : 2
    commit(next)
  }
  const removeWidget = (index: number) => commit(layout.filter((_, i) => i !== index))
  const resetLayout = () => { commit(DEFAULT_LAYOUT.map((entry) => [...entry] as LayoutEntry)); setPicker(false) }

  return <div style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
    <section aria-label="Ask Aelys" data-glass="" style={{ padding: 16, borderRadius: 24, background: 'rgba(255,255,255,.72)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,.35)', boxShadow: '0 8px 28px rgba(40,30,30,.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div aria-hidden="true" style={{ width: 48, height: 48, flex: 'none', borderRadius: '50%', background: ORB, boxShadow: '0 0 20px rgba(130,100,255,.5)' }} />
        <label className="home-composer" style={{ flex: 1, height: 56, borderRadius: 28, background: '#fff', display: 'flex', alignItems: 'center', padding: '0 8px 0 20px', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
          <input className="home-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(draft) }} placeholder="Ask Aelys or take an action…" aria-label="Ask Aelys or take an action" style={{ flex: 1, fontSize: 16, lineHeight: '24px' }} />
          <button type="button" className="home-btn home-send" onClick={() => ask(draft)} aria-label="Send" title="Send" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ArrowRight size={18} aria-hidden="true" /></button>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {HOME_CHIPS.map((chip) => <button key={chip.label} type="button" className="home-btn home-chip" onClick={() => askAelys(chip.label)}><chip.icon size={16} color={chip.color} aria-hidden="true" />{chip.label}</button>)}
      </div>
    </section>

    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 600, letterSpacing: '-.01em' }}>My day</h2>
        <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500, color: '#4F4A56' }}>{layout.length} widgets</span>
      </div>
      {editing
        ? <>
          <button type="button" className="home-btn home-tool" onClick={() => { setEditing(false); setPicker(false) }} style={{ padding: '0 16px', fontSize: 14 }}><Check size={18} aria-hidden="true" />Done</button>
          <div style={{ position: 'relative' }}>
            <button type="button" className="home-btn home-add" aria-haspopup="menu" aria-expanded={picker} onClick={() => setPicker((value) => !value)}><Plus size={18} aria-hidden="true" />Widget</button>
            {picker && <div role="menu" aria-label="Add to My day" className="home-picker" style={{ position: 'absolute', right: 0, top: 48, zIndex: 20, width: 300, padding: 8, borderRadius: 16, background: '#fff', boxShadow: '0 18px 50px rgba(20,10,30,.22)', border: '1px solid #EFEAE6' }}>
              <div style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, color: '#625D69', padding: '6px 10px' }}>Add to My day</div>
              {available.map((id) => {
                const def = WIDGET_CATALOG[id]
                const { c, soft } = accentOf(def.color)
                return <button key={id} type="button" role="menuitem" className="home-btn home-picker-item" onClick={() => addWidget(id)}>
                  <span style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: soft, color: c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><def.icon size={16} aria-hidden="true" /></span>
                  <span style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                    <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{def.title}</span>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: '#625D69' }}>{def.description}</span>
                  </span>
                  <Plus size={16} color="#5132D6" aria-hidden="true" />
                </button>
              })}
              {available.length === 0 && <div style={{ padding: '12px 10px', fontSize: 13, color: '#625D69' }}>All widgets are already on My day.</div>}
              <button type="button" role="menuitem" className="home-btn home-picker-item home-picker-reset" onClick={resetLayout}><RotateCcw size={16} aria-hidden="true" />Reset to default layout</button>
            </div>}
          </div>
        </>
        : <button type="button" className="home-btn home-tool" onClick={() => setEditing(true)}><LayoutGrid size={16} aria-hidden="true" />Customize</button>}
    </div>

    <section aria-label="Dashboard widgets" style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: 16, alignItems: 'start' }}>
      {layout.map(([id, span], index) => <HomeWidget key={id} id={id} span={span} cols={cols}index={index} count={layout.length} editing={editing} done={done} focus={focus} onToggleTask={toggleTask} onMove={(delta) => moveWidget(index, delta)} onResize={() => resizeWidget(index)} onRemove={() => removeWidget(index)} />)}
    </section>
    <div style={{ height: 12 }} />
  </div>
}
