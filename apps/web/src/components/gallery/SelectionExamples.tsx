import { useId, useState } from 'react'
import { Checkbox, MultiSelect, SelectField, type SelectOption } from '../controls/SelectionControls'

const modules: SelectOption[] = [
  { value: 'tasks', label: 'Задачи' }, { value: 'notes', label: 'Заметки' },
  { value: 'calendar', label: 'Календарь' }, { value: 'projects', label: 'Проекты' },
  { value: 'mail', label: 'Почта' }, { value: 'archive', label: 'Архив', disabled: true },
]
const priorities = [{ value: 'low', label: 'Низкий' }, { value: 'normal', label: 'Обычный' }, { value: 'high', label: 'Высокий' }]

export function SelectExamples() {
  const [priority, setPriority] = useState('normal')
  const [required, setRequired] = useState('')
  const [validate, setValidate] = useState(false)
  const [selected, setSelected] = useState(['tasks', 'notes'])
  return <div className="component-gallery__control-grid">
    <SelectField label="Приоритет" value={priority} onChange={setPriority} options={priorities} />
    <SelectField label="Недоступный селект" value="normal" onChange={() => {}} options={priorities} disabled />
    <div className="component-gallery__control-stack">
      <SelectField label="Обязательный раздел" value={required} onChange={setRequired} options={modules} error={validate && !required ? 'Выберите раздел.' : undefined} />
      <button type="button" className="button button--quiet" onClick={() => setValidate(true)}>Проверить выбор</button>
    </div>
    <MultiSelect label="Несколько разделов" value={selected} onChange={setSelected} options={modules} />
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
      <Checkbox label="Отдельный чекбокс" checked={checked} onChange={setChecked} />
      <Checkbox label="Недоступный чекбокс" checked disabled onChange={() => {}} />
      <fieldset className="component-gallery__choice-group"><legend>Группа чекбоксов</legend>
        <Checkbox label="Выбрать все разделы" checked={chosen.length === all.length} indeterminate={chosen.length > 0 && chosen.length < all.length} onChange={next => setChosen(next ? all.map(item => item.value) : [])} />
        <div className="component-gallery__nested-options">{all.map(option => <Checkbox key={option.value} label={option.label} checked={chosen.includes(option.value)} onChange={next => setChosen(next ? [...chosen, option.value] : chosen.filter(item => item !== option.value))} />)}</div>
      </fieldset>
    </div>
    <fieldset className="component-gallery__choice-group"><legend>Вид списка</legend>
      {[['list', 'Список'], ['grid', 'Сетка'], ['calendar', 'Календарь']].map(([value, label]) => <label className="component-gallery__radio" key={value}><input type="radio" name={radioId} value={value} checked={view === value} onChange={() => setView(value)} /><span>{label}</span></label>)}
      <label className="component-gallery__radio"><input type="radio" name={radioId} value="unavailable" disabled /><span>Недоступный вариант</span></label>
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
      <label className="component-gallery__label" htmlFor={`${id}-range`}>Прогресс <output htmlFor={`${id}-range`}>{progress}%</output></label>
      <input className="component-gallery__range" id={`${id}-range`} type="range" min="0" max="100" value={progress} onChange={event => setProgress(Number(event.target.value))} />
      <progress className="component-gallery__progress" value={progress} max="100" aria-label="Пример прогресса">{progress}%</progress>
      <label className="component-gallery__label" htmlFor={`${id}-count`}>Количество</label>
      <div className="component-gallery__stepper"><button type="button" aria-label="Уменьшить количество" disabled={count <= 0} onClick={() => setCount(Math.max(0, count - 1))}>−</button><input id={`${id}-count`} type="number" min="0" max="10" value={count} onChange={event => setCount(Math.min(10, Math.max(0, Number(event.target.value))))} /><button type="button" aria-label="Увеличить количество" disabled={count >= 10} onClick={() => setCount(Math.min(10, count + 1))}>+</button></div>
    </div>
    <div className="component-gallery__control-stack">
      <label className="component-gallery__label" htmlFor={`${id}-date`}>Дата</label>
      <input className="component-gallery__field" id={`${id}-date`} type="date" value={date} onChange={event => setDate(event.target.value)} />
      <label className="component-gallery__label" htmlFor={`${id}-text`}>Комментарий</label>
      <textarea className="component-gallery__field" id={`${id}-text`} rows={3} maxLength={200} value={text} onChange={event => setText(event.target.value)} placeholder="Несколько строк текста" />
      <span className="component-gallery__help">{text.length}/200</span>
    </div>
  </div>
}
