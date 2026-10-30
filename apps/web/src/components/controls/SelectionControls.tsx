import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search, X } from '../../icons'
import './selection-controls.css'

export type SelectOption = { value: string; label: string; disabled?: boolean }

type SelectProps = {
  label: string; value: string; onChange: (value: string) => void; options: SelectOption[]
  placeholder?: string; disabled?: boolean; error?: string
}
export function SelectField({ label, value, onChange, options, placeholder = 'Выберите вариант', disabled = false, error }: SelectProps) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState({ above: false, height: 280 })
  const selected = options.find(option => option.value === value)
  const visible = open && !disabled
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)

  const show = (last = false) => {
    if (disabled) return
    const current = options.findIndex(option => option.value === value && !option.disabled)
    setActive(current >= 0 ? current : (last ? enabled.at(-1) : enabled[0]) ?? -1)
    typeahead.current = { text: '', at: 0 }
    setOpen(true)
  }
  const close = () => { setOpen(false); typeahead.current.text = '' }
  const choose = (index: number) => {
    const option = options[index]
    if (disabled || !option || option.disabled) return
    onChange(option.value)
    close()
    trigger.current?.focus()
  }
  useEffect(() => {
    if (!visible) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - 16
      const above = rect.top - 16
      const useAbove = below < 180 && above > below
      setPlacement({ above: useAbove, height: Math.max(80, Math.min(280, useAbove ? above : below)) })
    }
    position()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [visible])
  useEffect(() => {
    if (visible) list.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [visible, active])

  return <div ref={root} className="aelys-selection-field aelys-single-select" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close()
  }}>
    <label id={`${id}-label`} htmlFor={id}>{label}</label>
    <div className="aelys-select-wrap">
      <button ref={trigger} type="button" id={id} role="combobox" className="aelys-select-trigger" disabled={disabled}
        aria-labelledby={`${id}-label`} aria-expanded={visible} aria-haspopup="listbox" aria-controls={visible ? `${id}-list` : undefined}
        aria-activedescendant={visible && options[active] && !options[active].disabled ? `${id}-option-${active}` : undefined}
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
        onClick={() => visible ? close() : show()} onKeyDown={event => {
          if (disabled) return
          const key = event.key
          if (key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(); return }
          if (key === 'Tab') { close(); return }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
            event.preventDefault()
            if (!visible) { show(key === 'ArrowUp' || key === 'End'); if (key === 'Home' || key === 'End') setActive((key === 'Home' ? enabled[0] : enabled.at(-1)) ?? -1); return }
            const current = enabled.indexOf(active)
            const next = key === 'Home' ? enabled[0] : key === 'End' ? enabled.at(-1)
              : enabled[Math.min(enabled.length - 1, Math.max(0, current + (key === 'ArrowDown' ? 1 : -1)))]
            setActive(next ?? -1)
            return
          }
          if (key === 'Enter' || (key === ' ' && (!visible || !typeahead.current.text || Date.now() - typeahead.current.at >= 700))) {
            event.preventDefault()
            if (visible) choose(active); else show()
            return
          }
          if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            const now = Date.now()
            const previous = now - typeahead.current.at < 700 ? typeahead.current.text : ''
            const text = previous + key.toLocaleLowerCase()
            typeahead.current = { text, at: now }
            const prefix = [...text].every(char => char === text[0]) ? text[0] : text
            const from = visible ? active : options.findIndex(option => option.value === value)
            const order = [...enabled.filter(index => index > from), ...enabled.filter(index => index <= from)]
            const match = order.find(index => options[index].label.toLocaleLowerCase().startsWith(prefix))
            if (!visible) setOpen(true)
            if (match !== undefined) setActive(match)
          }
        }}>
        <span className={!selected ? 'aelys-select-trigger__placeholder' : undefined}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {visible && <div ref={list} id={`${id}-list`} className="aelys-select-list" data-placement={placement.above ? 'above' : 'below'}
        style={{ maxHeight: placement.height }} role="listbox" aria-labelledby={`${id}-label`}>
        {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} data-option-index={index}
          className="aelys-select-option" role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          data-active={index === active && !option.disabled ? '' : undefined}
          onPointerMove={() => { if (!option.disabled) setActive(index) }}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
          <span>{option.label}</span>{option.value === value && <Check size={16} aria-hidden="true" />}
        </div>)}
        {!options.length && <div className="aelys-select-empty">Нет вариантов</div>}
      </div>}
    </div>
    {error && <span id={`${id}-error`} className="aelys-selection-error">{error}</span>}
  </div>
}

type CheckboxProps = {
  label: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; indeterminate?: boolean
}
export function Checkbox({ label, checked, onChange, disabled, indeterminate = false }: CheckboxProps) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (input.current) input.current.indeterminate = indeterminate }, [indeterminate])
  return <label className={`aelys-checkbox${disabled ? ' aelys-checkbox--disabled' : ''}`}>
    <input ref={input} type="checkbox" checked={checked} disabled={disabled} aria-checked={indeterminate ? 'mixed' : checked} onChange={event => onChange(event.target.checked)} />
    <span className="aelys-checkbox__box" aria-hidden="true">{indeterminate ? <span className="aelys-checkbox__dash" /> : <Check size={14} />}</span>
    <span>{label}</span>
  </label>
}

type MultiSelectProps = {
  label: string; value: string[]; onChange: (value: string[]) => void; options: SelectOption[]; disabled?: boolean
}
/** Nonmodal checkbox picker: native Space/Tab navigation, Escape, search and chips. */
export function MultiSelect({ label, value, onChange, options, disabled = false }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const selected = options.filter(option => value.includes(option.value))
  const matches = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const visible = open && !disabled
  useEffect(() => {
    if (!visible) return
    search.current?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [visible])
  const close = () => { setOpen(false); trigger.current?.focus() }
  const change = (option: SelectOption, checked: boolean) => {
    if (disabled || option.disabled) return
    onChange(checked ? [...value.filter(item => item !== option.value), option.value] : value.filter(item => item !== option.value))
  }
  return <div ref={root} className="aelys-multiselect aelys-selection-field" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }} onKeyDown={event => {
    if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <label id={`${id}-label`} htmlFor={`${id}-trigger`}>{label}</label>
    <button ref={trigger} id={`${id}-trigger`} type="button" className="aelys-multiselect__trigger" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-summary`} aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? `${id}-panel` : undefined}
      onClick={() => { setOpen(!visible); setQuery('') }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setQuery('') }
      }}>
      <span id={`${id}-summary`}>{selected.length ? `${selected.length} выбрано` : 'Выберите разделы'}</span><ChevronDown size={17} />
    </button>
    {selected.length > 0 && <div className="aelys-multiselect__chips" aria-label="Выбранные разделы">
      {selected.map(option => <span className="aelys-selection-chip" key={option.value}>{option.label}<button type="button" aria-label={`Убрать ${option.label}`} disabled={disabled || option.disabled} onClick={() => change(option, false)}><X size={12} /></button></span>)}
    </div>}
    {visible && <div id={`${id}-panel`} className="aelys-multiselect__panel" role="dialog" aria-labelledby={`${id}-label`}>
      <div className="aelys-multiselect__search"><Search size={16} /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={`Поиск: ${label}`} placeholder="Найти раздел" /></div>
      <fieldset className="aelys-multiselect__options"><legend className="aelys-visually-hidden">Варианты: {label}</legend>
        {matches.map(option => <Checkbox key={option.value} label={option.label} disabled={option.disabled} checked={value.includes(option.value)} onChange={checked => change(option, checked)} />)}
        {!matches.length && <p role="status">Ничего не найдено</p>}
      </fieldset>
      <div className="aelys-multiselect__footer"><button type="button" disabled={!value.some(item => options.some(option => option.value === item && !option.disabled))} onClick={() => onChange(value.filter(item => options.some(option => option.value === item && option.disabled)))}>Сбросить выбор</button><button type="button" onClick={close}>Готово</button></div>
    </div>}
  </div>
}
