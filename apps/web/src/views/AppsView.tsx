import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { Brush, Calculator, ChevronLeft, Dices, Globe, GraduationCap, Keyboard, Layers, MessageSquare, Pencil, Pin, Plus, Search, Terminal, Timer, Workflow, Wrench, BookOpen, ArrowUpRight, type LucideIcon } from 'lucide-react'
import { isMacPlatform } from '../data/navigation'
import { getSharedApiClient } from '../lib/api'
import { navigate } from '../lib/router'
import type { ApiStatus, RoutePath } from '../types'
import { CalculatorApp, DecideApp, ZonesApp, cityOf, zoneTime } from './LocalApps'
import { ToolboxApp } from './ToolboxApp'
import './apps.css'

type Tone = 'blue' | 'coral' | 'violet' | 'orange' | 'green'
type LocalId = 'toolbox' | 'calc' | 'zones' | 'decide'
type Entry = { group: string; id: string; title: string; icon: LucideIcon; desc: string; status?: string; route?: RoutePath; local?: LocalId; soon?: boolean }

const GROUPS: readonly { id: string; title: string; tone: Tone }[] = [
  { id: 'mind', title: 'Focus & calm', tone: 'coral' }, { id: 'quick', title: 'Quick tools', tone: 'violet' },
  { id: 'learn', title: 'Learn & create', tone: 'orange' }, { id: 'talk', title: 'Communicate', tone: 'blue' }, { id: 'power', title: 'Power tools', tone: 'green' },
]
// Tiles marked soon have no data source or screen in the product yet: they stay visible as designed but do nothing.
const CATALOG: readonly Entry[] = [
  { group: 'mind', id: 'focus', title: 'Focus', icon: Timer, desc: 'Pomodoro, breaks and stopwatch', route: '/timer' },
  { group: 'quick', id: 'calc', title: 'Calculator', icon: Calculator, desc: 'Math, units, percent and tips', local: 'calc', status: 'Units and percent' },
  { group: 'quick', id: 'zones', title: 'Zones', icon: Globe, desc: 'Time across cities', local: 'zones' },
  { group: 'quick', id: 'decide', title: 'Decide', icon: Dices, desc: 'Coin, dice and a choice wheel', local: 'decide', status: 'Coin · dice · wheel' },
  { group: 'quick', id: 'toolbox', title: 'Toolbox', icon: Wrench, desc: 'Password, Base64, URL, HTML, Unicode', local: 'toolbox', status: '5 tools' },
  { group: 'learn', id: 'cards', title: 'Cards', icon: Layers, desc: 'Flashcards with spaced repetition', soon: true },
  { group: 'learn', id: 'reader', title: 'Reader', icon: BookOpen, desc: 'Saved articles, distraction-free', soon: true },
  { group: 'learn', id: 'type', title: 'Type', icon: Keyboard, desc: 'Typing practice', soon: true },
  { group: 'learn', id: 'sketch', title: 'Sketch', icon: Brush, desc: 'Quick drawings and diagrams', soon: true },
  { group: 'talk', id: 'messages', title: 'Messages', icon: MessageSquare, desc: 'Telegram chats with AI reply drafts', route: '/messages' as RoutePath },
  { group: 'power', id: 'automation', title: 'Automation', icon: Workflow, desc: 'When this happens, do that', route: '/automation' },
  { group: 'power', id: 'dev', title: 'Developer Hub', icon: Terminal, desc: 'Local coding agent sessions', route: '/developer' },
]
const LOCAL_VIEWS: Record<LocalId, ComponentType> = { toolbox: ToolboxApp, calc: CalculatorApp, zones: ZonesApp, decide: DecideApp }
const DEFAULT_PINS = ['focus', 'messages', 'automation', 'toolbox']
const PINS_KEY = 'aelys.apps.pins.v1'
const SITES_KEY = 'aelys.apps.sites.v1'
const duration = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 60)}m`

type Site = { id: string; t: string; u: string }
const read = <T,>(key: string, ok: (value: unknown) => value is T, fallback: T): T => { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); if (ok(v)) return v } catch { /* fall back */ } return fallback }
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* optional */ } }
const isSites = (v: unknown): v is Site[] => Array.isArray(v) && v.every(s => s && typeof s.id === 'string' && typeof s.t === 'string' && typeof s.u === 'string')
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
export const siteHost = (value: string) => value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
/** Returns the https URL for a typed address, or null when it is not a plain web address. */
export function siteUrl(value: string): string | null {
  const host = siteHost(value)
  if (!/^[^\s/]+\.[^\s]{2,}/.test(host)) return null
  try { const url = new URL(`https://${host}`); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}

type Form = { id?: string; url: string; name: string; err: string }
const TINTS = ['violet', 'blue', 'green', 'coral', 'orange'] as const

export function AppsView({ apiStatus }: { apiStatus: ApiStatus }) {
  const mac = isMacPlatform()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<LocalId | null>(null)
  const [pins, setPins] = useState(() => read(PINS_KEY, isIds, DEFAULT_PINS))
  const [sites, setSites] = useState(() => read(SITES_KEY, isSites, []))
  const [form, setForm] = useState<Form | null>(null)
  const [live, setLive] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (apiStatus !== 'ready') return
    let cancelled = false
    const client = getSharedApiClient()
    const put = (id: string, text: string) => { if (!cancelled) setLive(current => ({ ...current, [id]: text })) }
    const quiet = () => undefined // a tile without a live status just shows its description
    client.focusSessions().then(sessions => { const today = new Date().toDateString(); put('focus', `${duration(sessions.filter(s => new Date(s.started_at).toDateString() === today).reduce((sum, s) => sum + s.elapsed_seconds, 0))} today`) }).catch(quiet)
    client.automations().then(rules => { const on = rules.filter(r => r.enabled !== false).length; put('automation', rules.length ? `${on} ${on === 1 ? 'rule' : 'rules'} on` : 'No rules yet') }).catch(quiet)
    if (mac) client.agentSessions().then(sessions => { const n = sessions.filter(s => s.state === 'active').length; put('dev', n ? `${n} running` : 'None running') }).catch(quiet)
    return () => { cancelled = true }
  }, [apiStatus, mac])
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id) }, [])

  const entries = useMemo(() => CATALOG.filter(entry => entry.id !== 'dev' || mac), [mac])
  const zonesStatus = useMemo(() => {
    const zones = read('aelys.apps.zones.v1', isIds, ['Europe/London', 'America/New_York'])
    return zones.slice(0, 2).map(zone => `${cityOf(zone)} ${zoneTime(zone, now)}`).join(' · ') || 'Time across cities'
  }, [now])
  const statusOf = (entry: Entry) => entry.soon ? 'Not available yet' : entry.id === 'zones' ? zonesStatus : live[entry.id] ?? entry.status
  const toneOf = (entry: Entry): Tone => GROUPS.find(group => group.id === entry.group)!.tone
  const launch = (entry: Entry) => { if (entry.soon) return; if (entry.local) setOpen(entry.local); else if (entry.route) navigate(entry.route) }
  const togglePin = (id: string) => { const next = pins.includes(id) ? pins.filter(pin => pin !== id) : [...pins, id]; setPins(next); write(PINS_KEY, next) }

  const q = query.trim().toLowerCase()
  const hits = entries.filter(entry => !q || `${entry.title} ${entry.desc}`.toLowerCase().includes(q))
  const pinned = pins.map(id => entries.find(entry => entry.id === id && !entry.soon)).filter((entry): entry is Entry => !!entry)
  const sections: { title: string; sub: string; items: readonly Entry[] }[] = q ? (hits.length ? [{ title: 'Results', sub: String(hits.length), items: hits }] : [])
    : [{ title: 'Pinned', sub: 'Also in ⌘K', items: pinned }, ...GROUPS.map(group => ({ title: group.title, sub: group.id === 'power' ? 'macOS' : '', items: entries.filter(entry => entry.group === group.id && !pinned.includes(entry)) }))].filter(section => section.items.length)

  const saveSites = (next: Site[]) => { setSites(next); write(SITES_KEY, next); setForm(null) }
  const submitSite = () => {
    if (!form) return
    const url = siteUrl(form.url)
    if (!url) { setForm({ ...form, err: 'Enter an address like notion.so or mysite.com/app' }); return }
    const u = siteHost(form.url)
    const t = form.name.trim() || u.split('/')[0]!.replace(/^www\./, '').split('.')[0]!.replace(/^./, c => c.toUpperCase())
    saveSites(form.id ? sites.map(site => site.id === form.id ? { ...site, t, u } : site) : [...sites, { id: `s${Date.now().toString(36)}`, t, u }])
  }

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
