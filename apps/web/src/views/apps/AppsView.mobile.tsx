import { Plus, Search, Pin } from 'lucide-react'
import { useApps } from './useApps'
import { OpenLocal, SiteForm, SitesList } from './AppsShared'
import type { ApiStatus } from '../../types'
import './apps-mobile.css'

// Grouped tiles, two to a row. Opening an app or adding a site behaves as on desktop.
export function AppsMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useApps(apiStatus)
  if (t.open) return <OpenLocal t={t} className="apps apps-m" />
  const { query, setQuery, q, pins, sections, hits, statusOf, toneOf, launch, togglePin, form, setForm, sites } = t

  return <div className="apps apps-m">
    <label className="apps-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps" aria-label="Search apps" /></label>
    {sections.map(section => <section className="apps-group" key={section.title} aria-label={section.title}>
      <div className="apps-group__head"><h2>{section.title}</h2>{section.sub && <span>{section.sub}</span>}</div>
      <div className="apps-m__grid">{section.items.map(entry => { const Icon = entry.icon; const status = statusOf(entry); const on = pins.includes(entry.id)
        return <div className={`apps-m__tile apps-tone--${toneOf(entry)}${entry.soon ? ' apps-card--soon' : ''}`} key={entry.id}>
          <div className="apps-m__top"><span className="apps-card__icon"><Icon size={20} aria-hidden="true" /></span>
            {entry.soon ? <span className="apps-soon">Soon</span> : <button type="button" className="apps-pin" aria-label={`${on ? 'Unpin' : 'Pin'} ${entry.title}`} aria-pressed={on} onClick={() => togglePin(entry.id)}><Pin size={15} aria-hidden="true" /></button>}</div>
          <button type="button" className="apps-m__open" disabled={entry.soon} onClick={() => launch(entry)}>{entry.title}</button>
          <div className="apps-m__desc">{status || entry.desc}</div>
        </div> })}</div>
    </section>)}
    {q && !hits.length && <p className="apps-empty">No apps match “{query}”</p>}
    {!q && <section className="apps-group" aria-label="Your sites">
      <div className="apps-group__head apps-group__head--sites"><h2>Your sites</h2>{!form && <button type="button" className="apps-add" onClick={() => setForm({ url: '', name: '', err: '' })}><Plus size={14} aria-hidden="true" />Add site</button>}</div>
      <span className="apps-group__sub">{sites.length ? 'Open in the browser' : 'Add the sites you use every day'}</span>
      <SitesList t={t} />
    </section>}
    {!q && form && <>
      <div className="apps-m__backdrop" onClick={() => setForm(null)} />
      <div className="apps-m__sheet" role="dialog" aria-label={form.id ? 'Edit site' : 'Add site'}><SiteForm t={t} /></div>
    </>}
  </div>
}
