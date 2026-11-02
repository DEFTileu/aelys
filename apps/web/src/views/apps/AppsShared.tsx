import type { ComponentType } from 'react'
import { ArrowUpRight, ChevronLeft, Pencil } from 'lucide-react'
import { BreatheApp, CalculatorApp, DecideApp, ZonesApp } from '../LocalApps'
import { ToolboxApp } from '../ToolboxApp'
import { siteUrl, TINTS, type AppsState, type LocalId } from './useApps'
import '../apps.css'

const LOCAL_VIEWS: Record<LocalId, ComponentType> = { toolbox: ToolboxApp, calc: CalculatorApp, zones: ZonesApp, decide: DecideApp, breathe: BreatheApp }

/** An opened local app with a back bar; identical on desktop and mobile. */
export function OpenLocal({ t, className }: { t: AppsState; className: string }) {
  const Local = LOCAL_VIEWS[t.open!]
  return <div className={className}><div className="apps-back"><button type="button" onClick={() => t.setOpen(null)}><ChevronLeft size={16} aria-hidden="true" />Apps</button><strong>{t.openEntry?.title}</strong></div><Local /></div>
}

export function SiteForm({ t }: { t: AppsState }) {
  const { form, setForm, sites, saveSites, submitSite } = t
  if (!form) return null
  return <div className="apps-form">
    <div className="apps-form__fields">
      <input value={form.url} onChange={event => setForm({ ...form, url: event.target.value, err: '' })} onKeyDown={event => { if (event.key === 'Enter') submitSite(); if (event.key === 'Escape') setForm(null) }} placeholder="Address, e.g. notion.so" aria-label="Site address" autoFocus />
      <input value={form.name} onChange={event => setForm({ ...form, name: event.target.value, err: '' })} onKeyDown={event => { if (event.key === 'Enter') submitSite(); if (event.key === 'Escape') setForm(null) }} placeholder="Name (optional)" aria-label="Name" />
    </div>
    {form.err && <div className="apps-form__err" role="alert">{form.err}</div>}
    <div className="apps-form__actions"><button type="button" className="apps-save" onClick={submitSite}>{form.id ? 'Save' : 'Add'}</button><button type="button" className="apps-cancel" onClick={() => setForm(null)}>Cancel</button><span style={{ flex: 1 }} />{form.id && <button type="button" className="apps-remove" onClick={() => saveSites(sites.filter(site => site.id !== form.id))}>Remove</button>}</div>
  </div>
}

export function SitesList({ t }: { t: AppsState }) {
  return <div className="apps-sites">{t.sites.map((site, index) => <div className={`apps-site apps-tone--${TINTS[index % TINTS.length]}`} key={site.id}>
    <button type="button" className="apps-site__open" onClick={() => { const url = siteUrl(site.u); if (url) window.open(url, '_blank', 'noopener') }}>
      <span className="apps-site__letter">{site.t.charAt(0).toUpperCase()}</span><span className="apps-site__text"><strong>{site.t}</strong><small>{site.u}</small></span></button>
    <button type="button" className="apps-site__edit" aria-label={`Edit ${site.t}`} onClick={() => t.setForm({ id: site.id, url: site.u, name: site.t, err: '' })}><Pencil size={14} aria-hidden="true" /></button>
    <ArrowUpRight size={16} className="apps-site__arrow" aria-hidden="true" />
  </div>)}</div>
}
