import { useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, CircleMinus, LayoutGrid, Palette, Plus, RotateCcw, Zap } from 'lucide-react'
import { accentOf } from '../../data/desktop/home'
import { WALLPAPERS } from '../../data/desktop/settings'
import { DEFAULT_MOBILE_WIDGETS, MOBILE_CATALOG, QUICK_ACTIONS, SIZE_NAME, type MobileWidget, type MobileWidgetId } from '../../data/mobile'
import { setSettings, useDesktopState } from '../../lib/desktopStore'

const TABS = [{ title: 'Widgets', icon: LayoutGrid }, { title: 'Actions', icon: Zap }, { title: 'Appearance', icon: Palette }]
const THEMES = ['Light', 'System', 'Dark'] as const

type Theme = 'light' | 'dark'

export function MobileCustomize({ widgets, onWidgets, actions, onActions, theme, onTheme, onBack }: {
  widgets: MobileWidget[]
  onWidgets: (widgets: MobileWidget[]) => void
  actions: boolean[]
  onActions: (actions: boolean[]) => void
  theme: Theme
  onTheme: (theme: Theme) => void
  onBack: () => void
}) {
  const [tab, setTab] = useState(0)
  const [followSystem, setFollowSystem] = useState(false)
  const { wallpaper } = useDesktopState()
  const ids = widgets.map(([id]) => id)
  const available = (Object.keys(MOBILE_CATALOG) as MobileWidgetId[]).filter((id) => !ids.includes(id))
  const move = (i: number, delta: number) => {
    const j = i + delta
    if (j < 0 || j >= widgets.length) return
    const next = [...widgets]
    ;[next[i], next[j]] = [next[j], next[i]]
    onWidgets(next)
  }
  const pickTheme = (i: number) => {
    setFollowSystem(i === 1)
    onTheme(i === 0 ? 'light' : i === 2 ? 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  }
  const themeIndex = followSystem ? 1 : theme === 'dark' ? 2 : 0

  return <>
    <div className="m-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="m-btn m-round" aria-label="Back" onClick={onBack}><ArrowLeft size={20} aria-hidden="true" /></button>
        <h1 className="m-shadow" style={{ flex: 1, margin: 0, fontSize: 22, lineHeight: '28px', fontWeight: 700 }}>Customize home</h1>
        <span className="m-avatar" aria-label="Profile" role="img" />
      </div>
      <div style={{ marginTop: 16, maxWidth: 300, textShadow: '0 1px 10px rgba(20,20,45,.5)' }}>Choose widgets, their size and order. Changes are saved automatically.</div>
    </div>

    <div className="m-card" role="tablist" style={{ margin: '20px 16px 0', padding: 4, borderRadius: 28, display: 'flex', boxShadow: 'none' }}>
      {TABS.map(({ title, icon: Icon }, i) => <button key={title} type="button" role="tab" aria-selected={tab === i} className="m-btn" onClick={() => setTab(i)} style={{ flex: 1, height: 40, borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', background: tab === i ? '#fff' : 'transparent', color: tab === i ? '#5132D6' : '#3A3640', boxShadow: tab === i ? '0 1px 4px rgba(0,0,0,.08)' : 'none' }}><Icon size={16} aria-hidden="true" />{title}</button>)}
    </div>

    {tab === 0 && <>
      <div className="m-card" style={{ margin: '12px 16px 0', boxShadow: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}><div className="m-card-title">My widgets</div><div className="m-sub">{widgets.length} on home</div></div>
          <button type="button" className="m-btn m-pill" onClick={() => onWidgets(DEFAULT_MOBILE_WIDGETS.map((entry) => [...entry] as MobileWidget))} style={{ background: '#F4F0EC', fontSize: 13 }}><RotateCcw size={16} aria-hidden="true" />Reset</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {widgets.map(([id, size], i) => {
            const def = MOBILE_CATALOG[id]
            const { c, soft } = accentOf(def.color)
            return <div key={id} style={{ padding: '8px 8px 8px 12px', borderRadius: 16, background: '#F7F4F1' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 12, background: soft, color: c }}><def.icon size={18} aria-hidden="true" /></span>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ lineHeight: '20px', fontWeight: 600 }}>{def.title}</div><div className="m-sub">{SIZE_NAME[size]} · {size === 'S' ? 'half width' : 'full width'}</div></div>
                <button type="button" className="m-btn m-tile" aria-label={`Remove ${def.title}`} onClick={() => onWidgets(widgets.filter((_, j) => j !== i))} style={{ width: 36, height: 36, borderRadius: '50%', color: '#C9302C' }}><CircleMinus size={20} aria-hidden="true" /></button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <div className="m-seg" role="radiogroup" aria-label={`${def.title} size`}>
                  {def.sizes.map((s) => <button key={s} type="button" role="radio" aria-checked={s === size} className={`m-btn m-seg__item${s === size ? ' m-seg__item--on' : ''}`} onClick={() => onWidgets(widgets.map((entry, j) => j === i ? [id, s] : entry))}>{SIZE_NAME[s]}</button>)}
                </div>
                <button type="button" className="m-btn m-tile" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} style={{ width: 36, height: 36, borderRadius: 14, background: '#fff', opacity: i === 0 ? .35 : 1 }}><ArrowUp size={18} aria-hidden="true" /></button>
                <button type="button" className="m-btn m-tile" aria-label="Move down" disabled={i === widgets.length - 1} onClick={() => move(i, 1)} style={{ width: 36, height: 36, borderRadius: 14, background: '#fff', opacity: i === widgets.length - 1 ? .35 : 1 }}><ArrowDown size={18} aria-hidden="true" /></button>
              </div>
            </div>
          })}
        </div>
      </div>
      <div className="m-card" style={{ margin: '12px 16px 0', boxShadow: 'none' }}>
        <div className="m-card-title">Available widgets</div><div className="m-sub">Add what matters to you</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {available.map((id) => {
            const def = MOBILE_CATALOG[id]
            const { c, soft } = accentOf(def.color)
            return <div key={id} className="m-row">
              <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 12, background: soft, color: c }}><def.icon size={18} aria-hidden="true" /></span>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ lineHeight: '20px', fontWeight: 600 }}>{def.title}</div><div className="m-sub">{def.description}</div></div>
              <button type="button" className="m-btn m-pill" onClick={() => onWidgets([...widgets, [id, def.sizes[0]]])} style={{ background: '#EEEAFD', color: '#5132D6', fontWeight: 600 }}><Plus size={16} aria-hidden="true" />Add</button>
            </div>
          })}
          {available.length === 0 && <div className="m-sub" style={{ padding: 12, textAlign: 'center' }}>All widgets are on your home screen</div>}
        </div>
      </div>
    </>}

    {tab === 1 && <div className="m-card" style={{ margin: '12px 16px 0', boxShadow: 'none' }}>
      <div className="m-card-title">Quick actions</div><div className="m-sub" style={{ marginBottom: 8 }}>Shown above the command bar and in the command bar</div>
      {QUICK_ACTIONS.map(({ title, icon: Icon, color }, i) => {
        const { c, soft } = accentOf(color)
        return <button key={title} type="button" role="switch" aria-checked={actions[i]} className="m-btn" onClick={() => onActions(actions.map((on, j) => j === i ? !on : on))} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, borderTop: '1px solid #EFEAE6' }}>
          <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 10, background: soft, color: c }}><Icon size={16} aria-hidden="true" /></span>
          <span style={{ flex: 1 }}>{title}</span>
          <span className={`m-switch${actions[i] ? ' m-switch--on' : ''}`} aria-hidden="true"><span /></span>
        </button>
      })}
    </div>}

    {tab === 2 && <div className="m-card" style={{ margin: '12px 16px 0', boxShadow: 'none' }}>
      <div className="m-card-title" style={{ marginBottom: 12 }}>Theme</div>
      <div className="m-seg" role="radiogroup" aria-label="Theme">
        {THEMES.map((name, i) => <button key={name} type="button" role="radio" aria-checked={themeIndex === i} className={`m-btn m-seg__item${themeIndex === i ? ' m-seg__item--on' : ''}`} onClick={() => pickTheme(i)}>{name}</button>)}
      </div>
      <div className="m-card-title" style={{ margin: '20px 0 12px' }}>Wallpaper</div>
      <div role="radiogroup" aria-label="Wallpaper" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
        {WALLPAPERS.map((url, i) => <button key={url} type="button" role="radio" aria-checked={wallpaper === i} aria-label={`Wallpaper ${i + 1}`} className="m-btn" onClick={() => setSettings({ wallpaper: i })} style={{ height: 96, borderRadius: 14, background: `url('${url}') center/cover`, boxShadow: wallpaper === i ? '0 0 0 3px #6A4CF2' : 'none' }} />)}
      </div>
    </div>}
  </>
}
