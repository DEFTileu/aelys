import { useState, type FormEvent } from 'react'
import { AelysMark } from '../components/AelysMark'
import { Switch } from '../components/Switch'
import { Checkbox } from '../components/controls/SelectionControls'
import { SelectExamples, CheckboxExamples, RangeExamples } from '../components/gallery/SelectionExamples'
import { FeedbackExamples, MotionExamples } from '../components/gallery/FeedbackExamples'
import { Calendar, Check, Folder, House, Inbox, Moon, NotebookText, Search, Settings, SquareCheck, Sun } from '../icons'
import './components.css'

type Props = { theme: 'light' | 'dark'; onToggleTheme: () => void }

const sections = [
  ['buttons', 'Кнопки'], ['fields', 'Поля'], ['selects', 'Селекты'], ['checkboxes', 'Чекбоксы и радио'], ['toggles', 'Переключатели'],
  ['ranges', 'Слайдеры и ввод'], ['cards', 'Карточки'], ['feedback', 'Диалог и уведомления'], ['motion', 'Анимации'], ['states', 'Состояния'], ['icons', 'Иконки'], ['layout', 'Композиция'],
] as const

const icons = [
  [House, 'Главная'], [SquareCheck, 'Задачи'], [Calendar, 'Календарь'], [Folder, 'Проекты'],
  [NotebookText, 'Заметки'], [Search, 'Поиск'], [Settings, 'Настройки'], [Check, 'Готово'],
] as const

export function ComponentsView({ theme, onToggleTheme }: Props) {
  const [segment, setSegment] = useState('Все')
  const [name, setName] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [saved, setSaved] = useState(false)
  const [offExample, setOffExample] = useState(false)
  const [onExample, setOnExample] = useState(true)
  const [setting, setSetting] = useState(false)
  const [selected, setSelected] = useState(false)
  const invalid = submitted && !name.trim()

  function saveExample(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitted(true)
    setSaved(Boolean(name.trim()))
  }

  return <div className="component-gallery">
    <header className="component-gallery__header">
      <a className="component-gallery__brand" href="/" aria-label="Aelys — на главную"><AelysMark size={32} /><span>Aelys</span></a>
      <div className="component-gallery__header-actions">
        <button className="component-gallery__theme" type="button" onClick={onToggleTheme} aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}>
          {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
        </button>
        <a className="component-gallery__open" href="/">Открыть Aelys</a>
      </div>
    </header>
    <div className="component-gallery__page">
      <aside className="component-gallery__sidebar">
        <nav aria-label="Разделы компонентов">
          <span className="component-gallery__nav-title">На этой странице</span>
          <div className="component-gallery__nav-links">{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</div>
        </nav>
      </aside>
      <main className="component-gallery__main">
        <div className="component-gallery__intro">
          <h1>Компоненты</h1>
          <p>Элементы интерфейса Aelys</p>
          <p className="component-gallery__note">Примеры работают локально и не сохраняют данные.</p>
        </div>

        <section className="component-gallery__section" id="buttons" aria-labelledby="buttons-title">
          <div className="component-gallery__section-heading"><h2 id="buttons-title">Кнопки</h2><p>Действия и выбор представления</p></div>
          <div className="component-gallery__specimen component-gallery__stack">
            <div className="component-gallery__row"><button className="button button--primary" type="button" onClick={() => setSaved(true)}>Сохранить пример</button><button className="button button--quiet" type="button" onClick={() => setSaved(false)}>Сбросить</button><button className="button button--quiet" type="button" disabled>Недоступно</button></div>
            <div className="pill-tabs component-gallery__segments" aria-label="Пример выбора представления">{['Все', 'Активные', 'Готовые'].map(item => <button key={item} type="button" aria-pressed={segment === item} className={`pill-tab${segment === item ? ' pill-tab--active' : ''}`} onClick={() => setSegment(item)}>{item}</button>)}</div>
            <span className="component-gallery__feedback" role="status">{saved ? 'Пример сохранён в текущем сеансе.' : ''}</span>
          </div>
        </section>

        <section className="component-gallery__section" id="fields" aria-labelledby="fields-title">
          <div className="component-gallery__section-heading"><h2 id="fields-title">Поля</h2><p>Ввод и проверка значения</p></div>
          <form className="component-gallery__specimen component-gallery__form" onSubmit={saveExample} noValidate>
            <label htmlFor="component-gallery-name">Название примера</label>
            <input id="component-gallery-name" value={name} onChange={event => { setName(event.target.value); setSaved(false) }} placeholder="Введите название" aria-invalid={invalid} aria-describedby="component-gallery-name-help" />
            <p id="component-gallery-name-help" className={invalid ? 'component-gallery__error' : 'component-gallery__help'}>{invalid ? 'Введите название, чтобы сохранить пример.' : 'Поле можно изменить и проверить.'}</p>
            <button className="button button--primary" type="submit">Сохранить</button>
            <span className="component-gallery__feedback" role="status">{saved && submitted && name.trim() ? 'Пример сохранён в текущем сеансе.' : ''}</span>
          </form>
        </section>

        <section className="component-gallery__section" id="selects" aria-labelledby="selects-title">
          <div className="component-gallery__section-heading"><h2 id="selects-title">Селекты</h2><p>Один вариант или несколько, поиск и выбранные теги</p></div>
          <div className="component-gallery__specimen"><SelectExamples /></div>
        </section>

        <section className="component-gallery__section" id="checkboxes" aria-labelledby="checkboxes-title">
          <div className="component-gallery__section-heading"><h2 id="checkboxes-title">Чекбоксы и радиокнопки</h2><p>Обычный, выбранный, частичный и недоступный варианты</p></div>
          <div className="component-gallery__specimen"><CheckboxExamples /></div>
        </section>

        <section className="component-gallery__section" id="toggles" aria-labelledby="toggles-title">
          <div className="component-gallery__section-heading"><h2 id="toggles-title">Переключатели</h2><p>Состояния и интерактивный пример</p></div>
          <div className="component-gallery__specimen component-gallery__switches">
            <div className="component-gallery__switch"><span>{offExample ? 'Включён' : 'Выключен'}</span><Switch label={offExample ? 'Включён' : 'Выключен'} checked={offExample} onCheckedChange={setOffExample} /></div>
            <div className="component-gallery__switch"><span>{onExample ? 'Включён' : 'Выключен'}</span><Switch label={onExample ? 'Включён' : 'Выключен'} checked={onExample} onCheckedChange={setOnExample} /></div>
            <div className="component-gallery__switch"><span>Недоступен</span><Switch label="Недоступен" checked={false} onCheckedChange={() => {}} disabled /></div>
            <div className="component-gallery__switch"><span>Ожидание</span><Switch label="Ожидание" checked onCheckedChange={() => {}} pending /></div>
            <div className="component-gallery__setting"><div><strong>Пример настройки</strong><p id="component-gallery-setting-help">Меняется только на этой странице.</p></div><Switch label="Пример настройки" checked={setting} onCheckedChange={setSetting} describedBy="component-gallery-setting-help" /></div>
          </div>
        </section>

        <section className="component-gallery__section" id="ranges" aria-labelledby="ranges-title">
          <div className="component-gallery__section-heading"><h2 id="ranges-title">Слайдеры и ввод</h2><p>Прогресс, количество, дата и многострочный текст</p></div>
          <div className="component-gallery__specimen"><RangeExamples /></div>
        </section>

        <section className="component-gallery__section" id="cards" aria-labelledby="cards-title">
          <div className="component-gallery__section-heading"><h2 id="cards-title">Карточки</h2><p>Выбор элемента</p></div>
          <div className="component-gallery__specimen"><div className="component-gallery__task"><Checkbox checked={selected} onChange={setSelected} label={<span><strong>Пример задачи</strong><small>{selected ? 'Выбрана' : 'Отметьте, чтобы выбрать'}</small></span>} /></div></div>
        </section>

        <section className="component-gallery__section" id="feedback" aria-labelledby="feedback-title">
          <div className="component-gallery__section-heading"><h2 id="feedback-title">Диалог и уведомления</h2><p>Открытие, закрытие и обратная связь</p></div>
          <div className="component-gallery__specimen"><FeedbackExamples /></div>
        </section>

        <section className="component-gallery__section" id="motion" aria-labelledby="motion-title">
          <div className="component-gallery__section-heading"><h2 id="motion-title">Анимации</h2><p>Появление карточки, нажатие и загрузка — запускаются по кнопке</p></div>
          <div className="component-gallery__specimen"><MotionExamples /></div>
        </section>

        <section className="component-gallery__section" id="states" aria-labelledby="states-title">
          <div className="component-gallery__section-heading"><h2 id="states-title">Состояния</h2><p>Пример пустого списка</p></div>
          <div className="component-gallery__specimen"><div className="component-gallery__empty"><Inbox size={22} /><div><strong>Пока нет элементов</strong><p>Здесь появятся добавленные элементы.</p></div></div></div>
        </section>

        <section className="component-gallery__section" id="icons" aria-labelledby="icons-title">
          <div className="component-gallery__section-heading"><h2 id="icons-title">Иконки</h2><p>Общие обозначения интерфейса</p></div>
          <div className="component-gallery__specimen component-gallery__icons">{icons.map(([Icon, label]) => <div key={label}><Icon size={22} /><span>{label}</span></div>)}</div>
        </section>

        <section className="component-gallery__section" id="layout" aria-labelledby="layout-title">
          <div className="component-gallery__section-heading"><h2 id="layout-title">Композиция</h2><p>Заголовок, описание и действие</p></div>
          <div className="component-gallery__specimen"><div className="component-gallery__layout"><div><strong>Название раздела</strong><p>Короткое описание содержимого.</p></div><button className="button button--quiet" type="button" onClick={() => setSelected(!selected)}>{selected ? 'Снять выбор' : 'Выбрать пример'}</button></div></div>
        </section>
      </main>
    </div>
  </div>
}
