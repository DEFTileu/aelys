import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react'
import { Brush, GraduationCap, Calculator, Brain, CircleDot, Dices, Disc3, Grid2x2, Hash, Worm, Zap, Globe, Keyboard, Layers, MessageSquare, Terminal, Timer, Workflow, Wrench, BookOpen, type LucideIcon } from 'lucide-react'
import { isMacPlatform } from '../../data/navigation'
import { getSharedApiClient } from '../../lib/api'
import { navigate } from '../../lib/router'
import type { GameId } from '../../lib/games'
import type { ApiStatus, RoutePath } from '../../types'
import { CalculatorApp, DecideApp, ZonesApp, cityOf, zoneTime } from '../LocalApps'
import { ToolboxApp } from '../ToolboxApp'

type Tone = 'blue' | 'coral' | 'violet' | 'orange' | 'green'
type LocalId = 'toolbox' | 'calc' | 'zones' | 'decide' | GameId
type Entry = { group: string; id: string; title: string; icon: LucideIcon; desc: string; status?: string; route?: RoutePath; local?: LocalId; soon?: boolean }

const GROUPS: readonly { id: string; title: string; tone: Tone }[] = [
  { id: 'mind', title: 'Focus & calm', tone: 'coral' }, { id: 'quick', title: 'Quick tools', tone: 'violet' }, { id: 'games', title: 'Games', tone: 'orange' },
  { id: 'learn', title: 'Learn & create', tone: 'orange' }, { id: 'talk', title: 'Communicate', tone: 'blue' }, { id: 'power', title: 'Power tools', tone: 'green' },
]
// Tiles marked soon have no data source or screen in the product yet: they stay visible as designed but do nothing.
const CATALOG: readonly Entry[] = [
  { group: 'mind', id: 'focus', title: 'Focus', icon: Timer, desc: 'Pomodoro, breaks and stopwatch', route: '/timer' },
  { group: 'quick', id: 'calc', title: 'Calculator', icon: Calculator, desc: 'Math, units, percent and tips', local: 'calc', status: 'Units and percent' },
  { group: 'quick', id: 'zones', title: 'Zones', icon: Globe, desc: 'Time across cities', local: 'zones' },
  { group: 'quick', id: 'decide', title: 'Decide', icon: Dices, desc: 'Coin, dice and a choice wheel', local: 'decide', status: 'Coin · dice · wheel' },
  { group: 'quick', id: 'toolbox', title: 'Toolbox', icon: Wrench, desc: 'Password, Base64, URL, HTML, Unicode', local: 'toolbox', status: '5 tools' },
  { group: 'games', id: 'hockey', title: 'Air hockey', icon: Disc3, desc: 'Two thumbs, one screen, first to 7', local: 'hockey', status: '2 players' },
  { group: 'games', id: 'duel', title: 'Reaction duel', icon: Zap, desc: 'Who taps first after the signal', local: 'duel', status: '2 players' },
  { group: 'games', id: 'c4', title: 'Connect four', icon: CircleDot, desc: 'Drop discs and line up four', local: 'c4', status: '2 players' },
  { group: 'games', id: 'ttt', title: 'Tic-tac-toe', icon: Hash, desc: 'The classic, with a running score', local: 'ttt', status: '2 players' },
  { group: 'games', id: 'snake', title: 'Snake', icon: Worm, desc: 'Eat, grow and do not crash', local: 'snake', status: 'Solo' },
  { group: 'games', id: '2048', title: '2048', icon: Grid2x2, desc: 'Slide and merge tiles', local: '2048', status: 'Solo' },
  { group: 'games', id: 'memory', title: 'Memory', icon: Brain, desc: 'Find all the pairs', local: 'memory', status: 'Solo' },
  { group: 'learn', id: 'english', title: 'English', icon: GraduationCap, desc: 'Daily words, review and a report', route: '/english' },
  { group: 'learn', id: 'cards', title: 'Cards', icon: Layers, desc: 'Flashcards with spaced repetition', soon: true },
  { group: 'learn', id: 'reader', title: 'Reader', icon: BookOpen, desc: 'Saved articles, distraction-free', soon: true },
  { group: 'learn', id: 'type', title: 'Type', icon: Keyboard, desc: 'Typing practice', soon: true },
  { group: 'learn', id: 'sketch', title: 'Sketch', icon: Brush, desc: 'Quick drawings and diagrams', soon: true },
  { group: 'talk', id: 'messages', title: 'Messages', icon: MessageSquare, desc: 'Telegram chats with AI reply drafts', route: '/messages' as RoutePath },
  { group: 'power', id: 'automation', title: 'Automation', icon: Workflow, desc: 'When this happens, do that', route: '/automation' },
  { group: 'power', id: 'dev', title: 'Developer Hub', icon: Terminal, desc: 'Local coding agent sessions', route: '/developer' },
]
// Games ship real-time canvas code, so load it only when a game tile is opened.
const LazyGames = lazy(() => import('../GamesApp'))
const game = (id: GameId): ComponentType => () => <Suspense fallback={null}><LazyGames id={id} /></Suspense>
export const LOCAL_VIEWS: Record<LocalId, ComponentType> = { toolbox: ToolboxApp, calc: CalculatorApp, zones: ZonesApp, decide: DecideApp, hockey: game('hockey'), duel: game('duel'), c4: game('c4'), ttt: game('ttt'), snake: game('snake'), '2048': game('2048'), memory: game('memory') }
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
export const TINTS = ['violet', 'blue', 'green', 'coral', 'orange'] as const

export function useApps(apiStatus: ApiStatus) {
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
  return { form, query, q, setQuery, open, setOpen, pins, sites, setForm, entries, statusOf, toneOf, launch, togglePin, hits, sections, saveSites, submitSite }
}
