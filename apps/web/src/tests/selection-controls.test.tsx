import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { Checkbox, MultiSelect, SelectField, type SelectOption } from '../components/controls/SelectionControls'
import { CheckboxExamples } from '../components/gallery/SelectionExamples'

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })
async function render(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(element) }); return host
}
const options: SelectOption[] = [{ value: 'tasks', label: 'Задачи' }, { value: 'notes', label: 'Заметки' }, { value: 'locked', label: 'Архив', disabled: true }]
function Example() {
  const [selected, setSelected] = useState(['tasks', 'locked'])
  return <><MultiSelect label="Разделы" options={options} value={selected} onChange={setSelected} /><button>Снаружи</button><output>{selected.join(',')}</output></>
}
function button(host: HTMLElement, name: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === name)! }
function checkbox(host: HTMLElement, label: string) { return [...host.querySelectorAll('label')].find(item => item.textContent === label)!.querySelector('input')! }

it('focuses search, filters, selects several values and restores trigger focus on Escape', async () => {
  const host = await render(<Example />)
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const search = host.querySelector<HTMLInputElement>('input[type=search]')!
  expect(document.activeElement).toBe(search)
  await act(async () => { checkbox(host, 'Заметки').click() })
  expect(host.querySelector('output')!.textContent).toContain('notes')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(search, 'несуществующий'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(host.querySelector('[role=status]')!.textContent).toBe('Ничего не найдено')
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(host.querySelector('[role=dialog]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('output')!.textContent).toBe('tasks,locked,notes')
})
it('clears only editable choices, removes chips, and closes on outside pointer input', async () => {
  const host = await render(<Example />)
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Убрать Задачи"]')!.click() })
  expect(host.querySelector('output')!.textContent).toBe('locked')
  await act(async () => { trigger.click() })
  await act(async () => { checkbox(host, 'Заметки').click() })
  await act(async () => { button(host, 'Сбросить выбор').click() })
  expect(host.querySelector('output')!.textContent).toBe('locked')
  expect(checkbox(host, 'Архив').disabled).toBe(true)
  await act(async () => { button(host, 'Снаружи').dispatchEvent(new Event('pointerdown', { bubbles: true })) })
  expect(host.querySelector('[role=dialog]')).toBeNull()
})
it('reflects partial group selection and lets the owner select or clear the entire group', async () => {
  const host = await render(<CheckboxExamples />)
  const master = checkbox(host, 'Выбрать все разделы')
  expect(master.indeterminate).toBe(true)
  expect(master.getAttribute('aria-checked')).toBe('mixed')
  await act(async () => { master.click() })
  expect(master.indeterminate).toBe(false)
  expect(master.checked).toBe(true)
  expect(checkbox(host, 'Задачи').checked).toBe(true)
  expect(checkbox(host, 'Заметки').checked).toBe(true)
  await act(async () => { master.click() })
  expect(checkbox(host, 'Календарь').checked).toBe(false)
})
it('keeps disabled checkbox values unchanged', async () => {
  let changes = 0
  const host = await render(<Checkbox checked label="Disabled" disabled onChange={() => { changes++ }} />)
  await act(async () => { host.querySelector('input')!.click() })
  expect(changes).toBe(0)
  expect(host.querySelector('input')!.checked).toBe(true)
})

function SingleExample() {
  const [value, setValue] = useState('tasks')
  return <><SelectField label="Раздел" value={value} options={[options[0], options[2], options[1]]} onChange={setValue} /><button>Снаружи</button><output>{value}</output></>
}
async function key(element: Element, value: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) })
}
it('navigates the custom single select, skips disabled choices and commits only on Enter', async () => {
  const host = await render(<SingleExample />)
  const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]')!
  trigger.focus()
  await key(trigger, 'ArrowDown')
  expect(host.querySelector('[role=listbox]')).not.toBeNull()
  expect(host.querySelector('[role=option][aria-selected=true]')!.textContent).toBe('Задачи')
  await key(trigger, 'ArrowDown')
  const active = document.getElementById(trigger.getAttribute('aria-activedescendant')!)!
  expect(active.textContent).toBe('Заметки')
  expect(host.querySelector('output')!.textContent).toBe('tasks')
  await key(trigger, 'Enter')
  expect(host.querySelector('output')!.textContent).toBe('notes')
  expect(host.querySelector('[role=listbox]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
it('supports typeahead, Home/End and cancellation without changing the controlled value', async () => {
  const host = await render(<SingleExample />)
  const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]')!
  trigger.focus()
  await key(trigger, 'End')
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)!.textContent).toBe('Заметки')
  await key(trigger, 'Home')
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)!.textContent).toBe('Задачи')
  await key(trigger, 'З'); await key(trigger, 'а'); await key(trigger, 'м')
  expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)!.textContent).toBe('Заметки')
  await key(trigger, 'Escape')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('output')!.textContent).toBe('tasks')
  await act(async () => { trigger.click() })
  await key(trigger, 'Tab')
  expect(host.querySelector('[role=listbox]')).toBeNull()
})
it('closes the single select outside, accepts pointer selection and refuses disabled items', async () => {
  const host = await render(<SingleExample />)
  const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]')!
  await act(async () => { trigger.click() })
  await act(async () => { host.querySelector<HTMLElement>('[role=option][aria-disabled=true]')!.click() })
  expect(host.querySelector('output')!.textContent).toBe('tasks')
  expect(host.querySelector('[role=listbox]')).not.toBeNull()
  await act(async () => { [...host.querySelectorAll<HTMLElement>('[role=option]')].find(option => option.textContent === 'Заметки')!.click() })
  expect(host.querySelector('output')!.textContent).toBe('notes')
  await act(async () => { trigger.click() })
  await act(async () => { button(host, 'Снаружи').dispatchEvent(new Event('pointerdown', { bubbles: true })) })
  expect(host.querySelector('[role=listbox]')).toBeNull()
})
