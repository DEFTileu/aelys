import type { ReactNode } from 'react'
import { ChevronDown } from '../../icons'
import './settings.css'

// Building blocks for the Settings panels. Their markup and class names follow the AelysSettings design component.

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`st-card st-list ${className}`.trim()}>{children}</div>
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div className="st-group"><div className="st-group-title">{title}</div>{children}</div>
}

export function Row({ title, hint, children, wrap, tall = true, id }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; wrap?: boolean; tall?: boolean; id?: string }) {
  return <div className={`st-row${wrap ? ' st-row--wrap' : ''}${tall ? '' : ' st-row--56'}`}>
    <div className="st-grow"><div className="st-label" id={id}>{title}</div>{hint && <div className="st-hint">{hint}</div>}</div>
    {children}
  </div>
}

export function SwitchRow({ title, hint, checked, onChange, disabled, pending }: { title: string; hint: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; pending?: boolean }) {
  return <Row title={title} hint={hint}><Switch label={title} checked={checked} onChange={onChange} disabled={disabled} pending={pending} /></Row>
}

/** Controlled switch: a pending request never changes the value optimistically. */
export function Switch({ label, checked, onChange, disabled, pending }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; pending?: boolean }) {
  return <button type="button" role="switch" className="st-switch" aria-label={label} aria-checked={checked} aria-busy={pending || undefined} disabled={disabled || pending} onClick={() => onChange(!checked)} />
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; disabled?: boolean }) {
  return <div className="st-seg" role="radiogroup" aria-label={label}>
    {options.map(([id, text]) => <button key={id} type="button" role="radio" aria-checked={value === id} disabled={disabled} onClick={() => onChange(id)}>{text}</button>)}
  </div>
}

/** The design's select chip: a native select, so keyboard and screen readers keep working. */
export function SelectChip({ label, value, options, onChange, disabled }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="st-select">
    <span>{options.find(([id]) => id === value)?.[1] ?? ''}</span>
    <ChevronDown size={14} aria-hidden="true" />
    <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
    </select>
  </label>
}

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <label className="st-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{label}</label>
}
