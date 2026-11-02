import { useEffect, useId, useRef, useState } from 'react'
import type { AIProvider } from '@aelys/shared'
import { COST_LABEL, EFFORTS, EFFORT_HINT, EFFORT_SHORT, SPEED_LABEL, choiceLabel, formatContext, isReady, modelName, modelsFor, providerLabel, supportsThinking, type Capability, type Effort, type ModelChoice } from '../data/aiModels'
import { Brain, Check, ChevronDown, ChevronRight, Search, Sparkles, X } from '../icons'
import { navigate } from '../lib/router'
import './model-picker.css'

const CAPABILITY: Readonly<Record<Capability, readonly [string, string]>> = {
  tools: ['Tools', 'Can use your tasks and calendar'], vision: ['Vision', 'Understands images'], thinking: ['Thinking', 'Extended thinking'],
}

export interface ModelPickerProps {
  /** Every chat provider, with or without a key; the ones without one are shown disabled. */
  readonly providers: readonly AIProvider[]
  readonly value: ModelChoice
  readonly onChange: (choice: ModelChoice) => void
  /** Select-pill trigger with a lighter popover (Settings); the default is the chat header pill. */
  readonly compact?: boolean
  readonly disabled?: boolean
  readonly showAuto?: boolean
  readonly showEffort?: boolean
  readonly isDefault?: boolean
  readonly onToggleDefault?: (on: boolean) => void
  readonly label?: string
  /** Model name only in the trigger (phone header). */
  readonly short?: boolean
}

export function ModelPicker({ providers, value, onChange, compact = false, disabled, showAuto = !compact, showEffort = false, short = false, isDefault, onToggleDefault, label = 'Model' }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  const ready = providers.filter(isReady)
  const current = providers.find((item) => item.id === value.providerId)
  const thinking = showEffort && value.model !== 'auto' && supportsThinking(current, value.model)
  const effort: Effort = value.effort ?? 'off'
  const needle = query.trim().toLocaleLowerCase()
  const pick = (choice: ModelChoice) => { onChange(choice); if (compact) setOpen(false) }
  const triggerText = compact
    ? current ? `${providerLabel(current.kind)} · ${value.model || String(current.model_policy?.default_model ?? 'default')}` : 'Not selected'
    : current ? (short && value.model !== 'auto' ? modelName(current, value.model) : choiceLabel(current, value)) : 'Choose a model'

  return <div className={`model-picker${compact ? ' model-picker--compact' : ''}`} ref={root}>
    <button type="button" className="model-picker__trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={label} disabled={disabled} onClick={() => setOpen(!open)}>
      {!compact && <span className="model-picker__mark" aria-hidden="true">{value.model === 'auto' ? <Sparkles size={12} /> : providerLabel(current?.kind ?? '?').charAt(0)}</span>}
      <span className="model-picker__text">{triggerText}</span>
      {thinking && effort !== 'off' && <span className="model-picker__effort" title="Reasoning effort"><Brain size={12} aria-hidden="true" />{EFFORT_SHORT[effort]}</span>}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="model-picker__popover" role="dialog" aria-label="Choose a model" id={id}>
      <div className="model-picker__search"><label><Search size={16} aria-hidden="true" /><input aria-label="Search models" placeholder="Search models" autoFocus={!compact} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" className="model-picker__close" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button></div>
      <div className="model-picker__list" role="listbox" aria-label="Models">
        {showAuto && ready.length > 0 && !needle && <button type="button" role="option" aria-selected={value.model === 'auto'} className="model-picker__row model-picker__row--auto" onClick={() => pick({ providerId: ready.some((item) => item.id === value.providerId) ? value.providerId : ready[0]!.id, model: 'auto', ...(value.effort ? { effort: value.effort } : {}) })}>
          <span className="model-picker__auto-icon"><Sparkles size={16} /></span><span className="model-picker__body"><b>Auto</b><span>Aelys picks the model for each question</span></span>{value.model === 'auto' && <Check size={18} aria-hidden="true" />}
        </button>}
        {providers.map((provider) => {
          const ok = isReady(provider)
          const models = modelsFor(provider).filter((item) => !needle || `${providerLabel(provider.kind)} ${item.name} ${item.id}`.toLocaleLowerCase().includes(needle))
          if (!models.length && (needle || ok)) return null
          return <div key={provider.id} className="model-picker__group">
            <div className="model-picker__group-head"><span className="model-picker__mark" aria-hidden="true">{providerLabel(provider.kind).charAt(0)}</span><b>{providerLabel(provider.kind)}</b>
              <span className={`model-picker__dot${ok ? ' model-picker__dot--ok' : ''}`} /><span className="model-picker__status">{ok ? 'Connected' : provider.has_secret ? 'Disabled' : 'No API key'}</span>
              {!ok && <button type="button" className="model-picker__link" onClick={() => navigate('/settings')}>Add key</button>}</div>
            {models.map((model) => {
              const on = ok && value.providerId === provider.id && value.model === model.id
              return <button type="button" key={model.id} role="option" aria-selected={on} aria-disabled={!ok} className="model-picker__row" disabled={!ok} onClick={() => pick({ providerId: provider.id, model: model.id, ...(value.effort ? { effort: value.effort } : {}) })}>
                <span className="model-picker__body"><b>{model.name}</b>{model.description && <span>{model.description}</span>}
                  <span className="model-picker__meta">
                    {model.context_tokens ? <i>{formatContext(model.context_tokens)}</i> : null}{model.speed ? <i>{SPEED_LABEL[model.speed]}</i> : null}{model.cost !== undefined ? <i>{COST_LABEL[model.cost]}</i> : null}
                    {model.capabilities.map((cap) => <i key={cap} className="model-picker__cap" title={CAPABILITY[cap][1]}>{CAPABILITY[cap][0]}</i>)}
                  </span></span>{on && <Check size={18} aria-hidden="true" />}
              </button>
            })}
          </div>
        })}
        {!providers.length && <p className="model-picker__empty">No providers yet. Add one in Settings.</p>}
        {providers.length > 0 && needle && !providers.some((item) => modelsFor(item).some((model) => `${providerLabel(item.kind)} ${model.name} ${model.id}`.toLocaleLowerCase().includes(needle))) && <p className="model-picker__empty">No models match “{query.trim()}”</p>}
      </div>
      <div className="model-picker__foot">
        {thinking && <div className="model-picker__effort-box"><div><b>Reasoning effort</b><span>{EFFORT_HINT[effort]}</span></div>
          <div className="model-picker__seg" role="radiogroup" aria-label="Reasoning effort">{EFFORTS.map(([key, text]) => <button type="button" key={key} role="radio" aria-checked={effort === key} onClick={() => onChange({ ...value, effort: key })}>{text}</button>)}</div></div>}
        <div className="model-picker__foot-row">
          {onToggleDefault && <label className="model-picker__default"><input type="checkbox" checked={!!isDefault} onChange={(event) => onToggleDefault(event.target.checked)} />Use for new chats</label>}
          <button type="button" className="model-picker__link model-picker__manage" onClick={() => navigate('/settings')}>Manage providers<ChevronRight size={14} aria-hidden="true" /></button>
        </div>
      </div>
    </div>}
  </div>
}
