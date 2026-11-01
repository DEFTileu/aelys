import { useId, useState } from 'react'
import { Checkbox, MultiSelect, SelectField, type SelectOption } from '../controls/SelectionControls'

const modules: SelectOption[] = [
  { value: 'tasks', label: 'Tasks' }, { value: 'notes', label: 'Notes' },
  { value: 'calendar', label: 'Calendar' }, { value: 'projects', label: 'Projects' },
  { value: 'mail', label: 'Mail' }, { value: 'archive', label: 'Archive', disabled: true },
]
const priorities = [{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }]

export function SelectExamples() {
  const [priority, setPriority] = useState('normal')
  const [required, setRequired] = useState('')
  const [validate, setValidate] = useState(false)
  const [selected, setSelected] = useState(['tasks', 'notes'])
  return <div className="component-gallery__control-grid">
    <SelectField label="Priority" value={priority} onChange={setPriority} options={priorities} />
    <SelectField label="Disabled select" value="normal" onChange={() => {}} options={priorities} disabled />
    <div className="component-gallery__control-stack">
      <SelectField label="Required section" value={required} onChange={setRequired} options={modules} error={validate && !required ? 'Choose a section.' : undefined} />
      <button type="button" className="button button--quiet" onClick={() => setValidate(true)}>Check selection</button>
    </div>
    <MultiSelect label="Multiple sections" value={selected} onChange={setSelected} options={modules} />
  </div>
}

export function CheckboxExamples() {
  const [checked, setChecked] = useState(false)
  const [chosen, setChosen] = useState(['tasks'])
  const [view, setView] = useState('list')
  const radioId = useId()
  const all = modules.slice(0, 3)
  return <div className="component-gallery__control-grid">
    <div className="component-gallery__control-stack">
      <Checkbox label="Standalone checkbox" checked={checked} onChange={setChecked} />
      <Checkbox label="Disabled checkbox" checked disabled onChange={() => {}} />
      <fieldset className="component-gallery__choice-group"><legend>Checkbox group</legend>
        <Checkbox label="Select all sections" checked={chosen.length === all.length} indeterminate={chosen.length > 0 && chosen.length < all.length} onChange={next => setChosen(next ? all.map(item => item.value) : [])} />
        <div className="component-gallery__nested-options">{all.map(option => <Checkbox key={option.value} label={option.label} checked={chosen.includes(option.value)} onChange={next => setChosen(next ? [...chosen, option.value] : chosen.filter(item => item !== option.value))} />)}</div>
      </fieldset>
    </div>
    <fieldset className="component-gallery__choice-group"><legend>List view</legend>
      {[['list', 'List'], ['grid', 'Grid'], ['calendar', 'Calendar']].map(([value, label]) => <label className="component-gallery__radio" key={value}><input type="radio" name={radioId} value={value} checked={view === value} onChange={() => setView(value)} /><span>{label}</span></label>)}
      <label className="component-gallery__radio"><input type="radio" name={radioId} value="unavailable" disabled /><span>Disabled option</span></label>
    </fieldset>
  </div>
}

export function RangeExamples() {
  const [progress, setProgress] = useState(40)
  const [count, setCount] = useState(2)
  const [text, setText] = useState('')
  const [date, setDate] = useState('')
  const id = useId()
  return <div className="component-gallery__control-grid">
    <div className="component-gallery__control-stack">
      <label className="component-gallery__label" htmlFor={`${id}-range`}>Progress <output htmlFor={`${id}-range`}>{progress}%</output></label>
      <input className="component-gallery__range" id={`${id}-range`} type="range" min="0" max="100" value={progress} onChange={event => setProgress(Number(event.target.value))} />
      <progress className="component-gallery__progress" value={progress} max="100" aria-label="Progress example">{progress}%</progress>
      <label className="component-gallery__label" htmlFor={`${id}-count`}>Quantity</label>
      <div className="component-gallery__stepper"><button type="button" aria-label="Decrease quantity" disabled={count <= 0} onClick={() => setCount(Math.max(0, count - 1))}>−</button><input id={`${id}-count`} type="number" min="0" max="10" value={count} onChange={event => setCount(Math.min(10, Math.max(0, Number(event.target.value))))} /><button type="button" aria-label="Increase quantity" disabled={count >= 10} onClick={() => setCount(Math.min(10, count + 1))}>+</button></div>
    </div>
    <div className="component-gallery__control-stack">
      <label className="component-gallery__label" htmlFor={`${id}-date`}>Date</label>
      <input className="component-gallery__field" id={`${id}-date`} type="date" value={date} onChange={event => setDate(event.target.value)} />
      <label className="component-gallery__label" htmlFor={`${id}-text`}>Comment</label>
      <textarea className="component-gallery__field" id={`${id}-text`} rows={3} maxLength={200} value={text} onChange={event => setText(event.target.value)} placeholder="Multi-line text" />
      <span className="component-gallery__help">{text.length}/200</span>
    </div>
  </div>
}
