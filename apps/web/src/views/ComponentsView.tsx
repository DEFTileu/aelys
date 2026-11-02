import { useState, type FormEvent } from 'react'
import { AelysMark } from '../components/AelysMark'
import { Switch } from '../components/Switch'
import { Checkbox } from '../components/controls/SelectionControls'
import { SelectExamples, CheckboxExamples, RangeExamples } from '../components/gallery/SelectionExamples'
import { FeedbackExamples, MotionExamples } from '../components/gallery/FeedbackExamples'
import { Calendar, Check, Folder, House, Inbox, Moon, NotebookText, Search, Settings, SquareCheck, Sun } from '../icons'
import { useIsMobile } from '../lib/useIsMobile'
import './components.css'
import './components-mobile.css'

type Props = { theme: 'light' | 'dark'; onToggleTheme: () => void }

const sections = [
  ['buttons', 'Buttons'], ['fields', 'Fields'], ['selects', 'Selects'], ['checkboxes', 'Checkboxes and radios'], ['toggles', 'Switches'],
  ['ranges', 'Sliders and input'], ['cards', 'Cards'], ['feedback', 'Dialog and notifications'], ['motion', 'Animations'], ['states', 'States'], ['icons', 'Icons'], ['layout', 'Composition'],
] as const

const icons = [
  [House, 'Home'], [SquareCheck, 'Tasks'], [Calendar, 'Calendar'], [Folder, 'Projects'],
  [NotebookText, 'Notes'], [Search, 'Search'], [Settings, 'Settings'], [Check, 'Done'],
] as const

export function ComponentsView({ theme, onToggleTheme }: Props) {
  const [segment, setSegment] = useState('All')
  const [name, setName] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [saved, setSaved] = useState(false)
  const [offExample, setOffExample] = useState(false)
  const [onExample, setOnExample] = useState(true)
  const [setting, setSetting] = useState(false)
  const [selected, setSelected] = useState(false)
  const invalid = submitted && !name.trim()
  // Same markup on both; only the layout CSS differs, so one component with a root modifier.
  const mobile = useIsMobile()

  function saveExample(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitted(true)
    setSaved(Boolean(name.trim()))
  }

  return <div className={mobile ? 'component-gallery component-gallery--m' : 'component-gallery'}>
    <header className="component-gallery__header">
      <a className="component-gallery__brand" href="/" aria-label="Aelys — home"><AelysMark size={32} /><span>Aelys</span></a>
      <div className="component-gallery__header-actions">
        <button className="component-gallery__theme" type="button" onClick={onToggleTheme} aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}>
          {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
        </button>
        <a className="component-gallery__open" href="/">Open Aelys</a>
      </div>
    </header>
    <div className="component-gallery__page">
      <aside className="component-gallery__sidebar">
        <nav aria-label="Component sections">
          <span className="component-gallery__nav-title">On this page</span>
          <div className="component-gallery__nav-links">{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</div>
        </nav>
      </aside>
      <main className="component-gallery__main">
        <div className="component-gallery__intro">
          <h1>Components</h1>
          <p>Aelys interface elements</p>
          <p className="component-gallery__note">Examples run locally and do not save data.</p>
        </div>

        <section className="component-gallery__section" id="buttons" aria-labelledby="buttons-title">
          <div className="component-gallery__section-heading"><h2 id="buttons-title">Buttons</h2><p>Actions and view selection</p></div>
          <div className="component-gallery__specimen component-gallery__stack">
            <div className="component-gallery__row"><button className="button button--primary" type="button" onClick={() => setSaved(true)}>Save example</button><button className="button button--quiet" type="button" onClick={() => setSaved(false)}>Reset</button><button className="button button--quiet" type="button" disabled>Unavailable</button></div>
            <div className="pill-tabs component-gallery__segments" aria-label="View selection example">{['All', 'Active', 'Completed'].map(item => <button key={item} type="button" aria-pressed={segment === item} className={`pill-tab${segment === item ? ' pill-tab--active' : ''}`} onClick={() => setSegment(item)}>{item}</button>)}</div>
            <span className="component-gallery__feedback" role="status">{saved ? 'Example saved for this session.' : ''}</span>
          </div>
        </section>

        <section className="component-gallery__section" id="fields" aria-labelledby="fields-title">
          <div className="component-gallery__section-heading"><h2 id="fields-title">Fields</h2><p>Input and validation</p></div>
          <form className="component-gallery__specimen component-gallery__form" onSubmit={saveExample} noValidate>
            <label htmlFor="component-gallery-name">Example name</label>
            <input id="component-gallery-name" value={name} onChange={event => { setName(event.target.value); setSaved(false) }} placeholder="Enter a name" aria-invalid={invalid} aria-describedby="component-gallery-name-help" />
            <p id="component-gallery-name-help" className={invalid ? 'component-gallery__error' : 'component-gallery__help'}>{invalid ? 'Enter a name to save the example.' : 'The field can be edited and validated.'}</p>
            <button className="button button--primary" type="submit">Save</button>
            <span className="component-gallery__feedback" role="status">{saved && submitted && name.trim() ? 'Example saved for this session.' : ''}</span>
          </form>
        </section>

        <section className="component-gallery__section" id="selects" aria-labelledby="selects-title">
          <div className="component-gallery__section-heading"><h2 id="selects-title">Selects</h2><p>Single or multiple choice, search and selected tags</p></div>
          <div className="component-gallery__specimen"><SelectExamples /></div>
        </section>

        <section className="component-gallery__section" id="checkboxes" aria-labelledby="checkboxes-title">
          <div className="component-gallery__section-heading"><h2 id="checkboxes-title">Checkboxes and radio buttons</h2><p>Default, selected, partial and disabled options</p></div>
          <div className="component-gallery__specimen"><CheckboxExamples /></div>
        </section>

        <section className="component-gallery__section" id="toggles" aria-labelledby="toggles-title">
          <div className="component-gallery__section-heading"><h2 id="toggles-title">Switches</h2><p>States and interactive example</p></div>
          <div className="component-gallery__specimen component-gallery__switches">
            <div className="component-gallery__switch"><span>{offExample ? 'On' : 'Off'}</span><Switch label={offExample ? 'On' : 'Off'} checked={offExample} onCheckedChange={setOffExample} /></div>
            <div className="component-gallery__switch"><span>{onExample ? 'On' : 'Off'}</span><Switch label={onExample ? 'On' : 'Off'} checked={onExample} onCheckedChange={setOnExample} /></div>
            <div className="component-gallery__switch"><span>Unavailable</span><Switch label="Unavailable" checked={false} onCheckedChange={() => {}} disabled /></div>
            <div className="component-gallery__switch"><span>Pending</span><Switch label="Pending" checked onCheckedChange={() => {}} pending /></div>
            <div className="component-gallery__setting"><div><strong>Setting example</strong><p id="component-gallery-setting-help">Changes apply to this page only.</p></div><Switch label="Setting example" checked={setting} onCheckedChange={setSetting} describedBy="component-gallery-setting-help" /></div>
          </div>
        </section>

        <section className="component-gallery__section" id="ranges" aria-labelledby="ranges-title">
          <div className="component-gallery__section-heading"><h2 id="ranges-title">Sliders and input</h2><p>Progress, quantity, date and multi-line text</p></div>
          <div className="component-gallery__specimen"><RangeExamples /></div>
        </section>

        <section className="component-gallery__section" id="cards" aria-labelledby="cards-title">
          <div className="component-gallery__section-heading"><h2 id="cards-title">Cards</h2><p>Item selection</p></div>
          <div className="component-gallery__specimen"><div className="component-gallery__task"><Checkbox checked={selected} onChange={setSelected} label={<span><strong>Example task</strong><small>{selected ? 'Selected' : 'Check to select'}</small></span>} /></div></div>
        </section>

        <section className="component-gallery__section" id="feedback" aria-labelledby="feedback-title">
          <div className="component-gallery__section-heading"><h2 id="feedback-title">Dialog and notifications</h2><p>Opening, closing and feedback</p></div>
          <div className="component-gallery__specimen"><FeedbackExamples /></div>
        </section>

        <section className="component-gallery__section" id="motion" aria-labelledby="motion-title">
          <div className="component-gallery__section-heading"><h2 id="motion-title">Animations</h2><p>Card entrance, press and loading — triggered by a button</p></div>
          <div className="component-gallery__specimen"><MotionExamples /></div>
        </section>

        <section className="component-gallery__section" id="states" aria-labelledby="states-title">
          <div className="component-gallery__section-heading"><h2 id="states-title">States</h2><p>Empty list example</p></div>
          <div className="component-gallery__specimen"><div className="component-gallery__empty"><Inbox size={22} /><div><strong>No items yet</strong><p>Added items will appear here.</p></div></div></div>
        </section>

        <section className="component-gallery__section" id="icons" aria-labelledby="icons-title">
          <div className="component-gallery__section-heading"><h2 id="icons-title">Icons</h2><p>Common interface symbols</p></div>
          <div className="component-gallery__specimen component-gallery__icons">{icons.map(([Icon, label]) => <div key={label}><Icon size={22} /><span>{label}</span></div>)}</div>
        </section>

        <section className="component-gallery__section" id="layout" aria-labelledby="layout-title">
          <div className="component-gallery__section-heading"><h2 id="layout-title">Composition</h2><p>Title, description and action</p></div>
          <div className="component-gallery__specimen"><div className="component-gallery__layout"><div><strong>Section title</strong><p>A short description of the content.</p></div><button className="button button--quiet" type="button" onClick={() => setSelected(!selected)}>{selected ? 'Clear selection' : 'Choose example'}</button></div></div>
        </section>
      </main>
    </div>
  </div>
}
