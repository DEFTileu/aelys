import { ArrowUpRight, ChevronLeft, Pencil, Pin, Plus, Search } from 'lucide-react'
import type { ApiStatus } from '../../types'
import { LOCAL_VIEWS, TINTS, siteUrl, useApps } from './useApps'
import '../apps.css'

export function AppsMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const { form, query, q, setQuery, open, setOpen, pins, sites, setForm, entries, statusOf, toneOf, launch, togglePin, hits, sections, saveSites, submitSite } = useApps(apiStatus)
  if (open) {
    const Local = LOCAL_VIEWS[open]
    const entry = entries.find(item => item.local === open)!
    return <div className="apps"><div className="apps-back"><button type="button" onClick={() => setOpen(null)}><ChevronLeft size={16} aria-hidden="true" />Apps</button><strong>{entry.title}</strong></div><Local /></div>
  }

  return <div className="apps">
    <label className="apps-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps" aria-label="Search apps" /><kbd>⌘K</kbd></label>
    {sections.map(section => <section className="apps-group" key={section.title} aria-label={section.title}>
      <div className="apps-group__head"><h2>{section.title}</h2>{section.sub && <span>{section.sub}</span>}</div>
      <div className="apps-grid">{section.items.map(entry => { const Icon = entry.icon; const status = statusOf(entry); const on = pins.includes(entry.id)
        return <div className={`apps-card apps-tone--${toneOf(entry)}${entry.soon ? ' apps-card--soon' : ''}`} key={entry.id}>
          <span className="apps-card__icon"><Icon size={20} aria-hidden="true" /></span>
          <div className="apps-card__body"><button type="button" className="apps-card__open" disabled={entry.soon} onClick={() => launch(entry)}>{entry.title}</button><div className="apps-card__desc" title={entry.desc}>{entry.desc}</div>{status && <div className="apps-card__status">{status}</div>}</div>
          {entry.soon ? <span className="apps-soon">Soon</span> : <button type="button" className="apps-pin" aria-label={`${on ? 'Unpin' : 'Pin'} ${entry.title}`} aria-pressed={on} onClick={() => togglePin(entry.id)}><Pin size={15} aria-hidden="true" /></button>}
        </div> })}</div>
    </section>)}
    {q && !hits.length && <p className="apps-empty">No apps match “{query}”</p>}
    {!q && <section className="apps-group" aria-label="Your sites">
      <div className="apps-group__head apps-group__head--sites"><h2>Your sites</h2><span className="apps-group__sub">{sites.length ? 'Open in the browser' : 'Add the sites you use every day'}</span>{!form && <button type="button" className="apps-add" onClick={() => setForm({ url: '', name: '', err: '' })}><Plus size={14} aria-hidden="true" />Add site</button>}</div>
      {form && <div className="apps-form">
        <div className="apps-form__fields">
          <input value={form.url} onChange={event => setForm({ ...form, url: event.target.value, err: '' })} onKeyDown={event => { if (event.key === 'Enter') submitSite(); if (event.key === 'Escape') setForm(null) }} placeholder="Address, e.g. notion.so" aria-label="Site address" autoFocus />
          <input value={form.name} onChange={event => setForm({ ...form, name: event.target.value, err: '' })} onKeyDown={event => { if (event.key === 'Enter') submitSite(); if (event.key === 'Escape') setForm(null) }} placeholder="Name (optional)" aria-label="Name" />
        </div>
        {form.err && <div className="apps-form__err" role="alert">{form.err}</div>}
        <div className="apps-form__actions"><button type="button" className="apps-save" onClick={submitSite}>{form.id ? 'Save' : 'Add'}</button><button type="button" className="apps-cancel" onClick={() => setForm(null)}>Cancel</button><span style={{ flex: 1 }} />{form.id && <button type="button" className="apps-remove" onClick={() => saveSites(sites.filter(site => site.id !== form.id))}>Remove</button>}</div>
      </div>}
      <div className="apps-sites">{sites.map((site, index) => <div className={`apps-site apps-tone--${TINTS[index % TINTS.length]}`} key={site.id}>
        <button type="button" className="apps-site__open" onClick={() => { const url = siteUrl(site.u); if (url) window.open(url, '_blank', 'noopener') }}>
          <span className="apps-site__letter">{site.t.charAt(0).toUpperCase()}</span><span className="apps-site__text"><strong>{site.t}</strong><small>{site.u}</small></span></button>
        <button type="button" className="apps-site__edit" aria-label={`Edit ${site.t}`} onClick={() => setForm({ id: site.id, url: site.u, name: site.t, err: '' })}><Pencil size={14} aria-hidden="true" /></button>
        <ArrowUpRight size={16} className="apps-site__arrow" aria-hidden="true" />
      </div>)}</div>
    </section>}
  </div>
}
