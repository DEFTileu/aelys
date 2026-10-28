import { ArrowRight, Plus, type LucideIcon } from 'lucide-react'
import './screen-toolbar.css'
import type { ReactNode } from 'react'

export type ToolbarButton = { label: string; icon: LucideIcon; color: string; onClick?: () => void }

// Shared toolbar from the desktop design: optional tabs, AI input, secondary buttons, primary action.
export function ScreenToolbar({ tabs, placeholder, secondary = [], primary, onPrimary, onAsk }: { tabs?: ReactNode; placeholder: string; secondary?: ToolbarButton[]; primary: string; onPrimary?: () => void; onAsk?: (text: string) => void }) {
  return <div className="screen-toolbar">
    {tabs}
    <form className="screen-toolbar__ai" onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('ask') as HTMLInputElement; if (input.value.trim()) { onAsk?.(input.value.trim()); input.value = '' } }}>
      <span className="ai-orb" aria-hidden="true" />
      <input name="ask" placeholder={placeholder} aria-label={placeholder} />
      <button type="submit" className="screen-toolbar__send" aria-label="Send"><ArrowRight size={14} /></button>
    </form>
    {secondary.map(({ label, icon: Icon, color, onClick }) => <button key={label} type="button" className="screen-toolbar__secondary" onClick={onClick}><Icon size={16} color={color} />{label}</button>)}
    <button type="button" className="screen-toolbar__primary" onClick={onPrimary}><Plus size={18} />{primary}</button>
  </div>
}

export function SegmentedTabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; icon?: LucideIcon }[]; value: T; onChange: (id: T) => void; label: string }) {
  return <div className="segmented-tabs" role="tablist" aria-label={label}>
    {tabs.map(({ id, label: text, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={id === value} className={id === value ? 'segmented-tabs__tab segmented-tabs__tab--active' : 'segmented-tabs__tab'} onClick={() => onChange(id)}>{Icon && <Icon size={16} />}{text}</button>)}
  </div>
}
