import { useState } from 'react'
import { ChevronUp, ChevronDown, Plus, RotateCcw, LayoutGrid, Sparkles, Settings, X } from '../icons'
import { accentOf } from '../data/desktop/home'
import { WIDGET_CATALOG, WIDGET_IDS, WIDGET_SIZES, MOBILE_DEFAULT_LAYOUT, normalizeWidgetSize, readLayout, reorderLayout, saveLayout, type LayoutEntry, type WidgetId } from './desktop/homeLayout'
import { MOBILE_ACTIONS, setMobileAction, useMobileActions } from '../lib/mobilePreferences'
import { SettingsScreen } from './desktop/SettingsScreen'
import { Switch } from '../components/Switch'
import './mobile-customize.css'

const sizes = WIDGET_SIZES.filter(size => size.span <= 2)
export function MobileCustomizeView({theme,onToggleTheme}:{theme:'light'|'dark';onToggleTheme:()=>void}) {
  const [tab,setTab] = useState('Widgets')
  const [layout,setLayout] = useState<LayoutEntry[]>(()=>readLayout(true))
  const [notice,setNotice] = useState('')
  const actions = useMobileActions()
  const save = (next:LayoutEntry[])=> { if (saveLayout(next,true)) { setLayout(next); setNotice('Changes saved') } else setNotice('Could not save. Allow local storage and try again.') }
  const changeSize = (id:WidgetId,span:number,height:number)=>save(layout.map(entry=>entry[0]===id ? [id,span,height] : entry))
  const move = (index:number,delta:number)=> { const target=layout[index+delta]; if(target) save(reorderLayout(layout,layout[index][0],target[0])) }
  return <div className="mobile-customize">
    <p className="mobile-customize__intro">Choose widgets, size and order. Size = width × height in tiles. Changes save automatically.</p>
    <div role="tablist" aria-label="Customize Home" className="mobile-customize__tabs">{[{label:'Widgets',icon:LayoutGrid},{label:'Actions',icon:Sparkles},{label:'Appearance',icon:Settings}].map(({label,icon:Icon})=><button key={label} type="button" role="tab" aria-selected={tab===label} aria-controls={`customize-${label}`} id={`customize-tab-${label}`} onClick={()=>setTab(label)}><Icon size={16}/>{label}</button>)}</div>
    <p className="mobile-customize__notice" role="status">{notice}</p>
    <section id={`customize-${tab}`} role="tabpanel" aria-labelledby={`customize-tab-${tab}`}>
      {tab==='Widgets' ? <>
        <div className="mobile-customize__card"><header><h2>My widgets <span>{layout.length}</span></h2><button type="button" onClick={()=>save(MOBILE_DEFAULT_LAYOUT.map(entry=>[...entry] as LayoutEntry))}><RotateCcw size={15}/>Reset</button></header>
        <ol className="mobile-customize__list">{layout.map(([id,span,height],index)=>{const def=WIDGET_CATALOG[id];const {c,soft}=accentOf(def.color); const size=normalizeWidgetSize(span,height); const current=WIDGET_SIZES.find(choice=>choice.span===size.span&&choice.rows===size.rows)!.label;return <li key={id}>
          <div className="mobile-customize__widget"><span className="mobile-customize__icon" style={{color:c,background:soft}}><def.icon size={18}/></span><div><strong>{def.title}</strong><small>{current} · {size.span===1?'half width':'full width'}</small></div><button type="button" className="mobile-customize__remove" aria-label={`Remove ${def.title}`} onClick={()=>save(layout.filter(([key])=>key!==id))}><X size={18}/></button></div>
          <div className="mobile-customize__controls"><div className="mobile-customize__sizes" role="radiogroup" aria-label={`Size of ${def.title}`}>{sizes.map(choice=><button key={choice.label} type="button" role="radio" aria-checked={current===choice.label} onClick={()=>changeSize(id,choice.span,choice.height)}>{choice.label}</button>)}</div><button type="button" disabled={index===0} aria-label={`Move ${def.title} up`} onClick={()=>move(index,-1)}><ChevronUp size={18}/></button><button type="button" disabled={index===layout.length-1} aria-label={`Move ${def.title} down`} onClick={()=>move(index,1)}><ChevronDown size={18}/></button></div>
        </li>})}</ol>{!layout.length&&<p>Add a widget below.</p>}</div>
        <div className="mobile-customize__card"><h2>Available widgets</h2><ul className="mobile-customize__list">{WIDGET_IDS.filter(id=>!layout.some(([key])=>key===id)).map(id=>{const def=WIDGET_CATALOG[id]; const {c,soft}=accentOf(def.color);return <li className="mobile-customize__widget" key={id}><span className="mobile-customize__icon" style={{color:c,background:soft}}><def.icon size={18}/></span><div><strong>{def.title}</strong><small>{def.description}</small></div><button type="button" aria-label={`Add ${def.title}`} onClick={()=>save([...layout,[id,['today','cal','mail','proj','activity'].includes(id)?2:1,176]])}><Plus size={16}/>Add</button></li>})}</ul>{layout.length===WIDGET_IDS.length&&<p>All widgets are on Home.</p>}</div>
      </> : tab==='Actions' ? <div className="mobile-customize__card"><h2>Quick actions</h2><p>Shown above the command bar.</p>{MOBILE_ACTIONS.map((action,index)=><div className="mobile-customize__action" key={action.label}><span className="mobile-customize__icon" style={{color:action.color,background:`${action.color}1A`}}><action.icon size={18}/></span><strong>{action.label}</strong><Switch label={action.label} checked={actions[index]} onCheckedChange={value=>setNotice(setMobileAction(index,value)?'Changes saved':'Could not save action preferences.')}/></div>)}</div> : <SettingsScreen theme={theme} onToggleTheme={onToggleTheme}/>}
    </section>
  </div>
}
