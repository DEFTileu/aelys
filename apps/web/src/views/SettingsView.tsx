import { useEffect, useState } from 'react'
import { useOwner } from '../lib/owner'
import { Bell, Calendar, ChevronRight, CloudSun, Info, Mail, Paintbrush, Search, Send, Shield, Sparkles, User, Wifi, type AelysIconComponent } from '../icons'
import type { ApiStatus } from '../types'
import { AppearancePanel } from './settings/AppearancePanel'
import { AboutPanel, ConnectionPanel, NotificationsPanel, ProfilePanel, SecurityPanel } from './settings/panels'
import { WeatherPanel } from './settings/WeatherPanel'
import { AccountsPanel } from './settings/AccountsPanel'
import { GoogleCalendarSettings } from './GoogleCalendarSettings'
import { MemorySettings } from './MemorySettings'
import { ProviderSettings } from './ProviderSettings'
import { TelegramSettings } from './TelegramSettings'
import './actual-settings.css'
import './settings/settings.css'

type PanelId = 'profile' | 'notifications' | 'appearance' | 'weather' | 'calendar' | 'ai' | 'memory' | 'telegram' | 'accounts' | 'connection' | 'security' | 'about'
type Section = { id: PanelId; title: string; desc: string; icon: AelysIconComponent; tone: string }

// Groups, titles, descriptions and tile colors are the design's. Memory and Google Calendar are Aelys sections the design lacks.
const GROUPS: readonly { title: string; items: readonly Section[] }[] = [
  { title: 'Account', items: [
    { id: 'profile', title: 'Profile', desc: 'Name and how Aelys addresses you', icon: User, tone: 'profile' },
    { id: 'notifications', title: 'Notifications', desc: 'What can interrupt you, and when', icon: Bell, tone: 'alert' },
  ] },
  { title: 'General', items: [
    { id: 'appearance', title: 'Appearance', desc: 'Theme, accent and motion', icon: Paintbrush, tone: 'violet' },
    { id: 'weather', title: 'Weather & location', desc: 'City and units', icon: CloudSun, tone: 'blue' },
    { id: 'calendar', title: 'Google Calendar', desc: 'Read-only event import', icon: Calendar, tone: 'blue' },
  ] },
  { title: 'Assistant', items: [
    { id: 'ai', title: 'AI & models', desc: 'Providers and the models Aelys uses', icon: Sparkles, tone: 'violet' },
    { id: 'memory', title: 'Memory', desc: 'Saved facts and preferences', icon: Sparkles, tone: 'violet' },
    { id: 'telegram', title: 'Telegram', desc: 'Connection, auto-reply and instructions', icon: Send, tone: 'blue' },
  ] },
  { title: 'System', items: [
    { id: 'accounts', title: 'Connected accounts', desc: 'Gmail and Telegram', icon: Mail, tone: 'blue' },
    { id: 'connection', title: 'Connection', desc: 'Backend address and your session', icon: Wifi, tone: 'green' },
    { id: 'security', title: 'Security', desc: 'Touch ID and session unlock', icon: Shield, tone: 'coral' },
    { id: 'about', title: 'Data & about', desc: 'Version and sync', icon: Info, tone: 'gray' },
  ] },
]
const ALL = GROUPS.flatMap((group) => group.items)

export function SettingsView({ apiStatus }: { apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const owner = useOwner(apiStatus)
  const [query, setQuery] = useState('')
  const sectionFromUrl = () => ALL.find((item) => item.id === new URLSearchParams(window.location.search).get('section'))?.id
  const initial = sectionFromUrl()
  const [panel, setPanel] = useState<PanelId>(initial ?? 'profile')
  // On a phone the list and the panel take turns, as in the design's compact layout. The open panel lives in the URL,
  // so the shell's back button can step from a panel to the list.
  const [open, setOpen] = useState(!!initial)
  useEffect(() => {
    const onPopState = () => { const id = sectionFromUrl(); if (id) setPanel(id); setOpen(!!id) }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const q = query.trim().toLocaleLowerCase()
  const groups = GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !q || `${item.title} ${item.desc}`.toLocaleLowerCase().includes(q)) })).filter((group) => group.items.length)
  const go = (id: PanelId) => { setPanel(id); setOpen(true); window.history.pushState({}, '', `?section=${id}`) }
  const current = ALL.find((item) => item.id === panel)!

  return <div className="st" data-open={open}>
    <aside className="st-nav" aria-label="Settings">
      <label className="st-search"><Search size={14} aria-hidden="true" /><input aria-label="Search settings" placeholder="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <nav aria-label="Settings sections" style={{ display: 'contents' }}>
        {groups.map((group) => <section key={group.title} style={{ display: 'contents' }} aria-label={group.title}>
          <div className="st-nav-group">{group.title}</div>
          <div className="st-nav-list">
            {group.items.map((item) => { const NavIcon = item.icon; return <button key={item.id} type="button" className="st-nav-item" data-section={item.id} aria-current={panel === item.id ? 'page' : undefined} onClick={() => go(item.id)}>
              <span className={`st-tile st-tone-${item.tone}`}><NavIcon size={14} aria-hidden="true" /></span>
              <span className="st-nav-text"><span>{item.title}</span><span className="st-nav-desc">{item.desc}</span></span>
              <ChevronRight className="st-nav-chevron" size={14} aria-hidden="true" />
            </button> })}
          </div>
        </section>)}
        {!groups.length && <p className="st-nav-empty">No settings sections found.</p>}
      </nav>
    </aside>
    <main className="st-panel">
      <div className="st-head">
        <div><h2 className="st-title">{current.title}</h2><div className="st-sub">{current.desc}</div></div>
      </div>
      {panel === 'profile' && <ProfilePanel owner={owner} />}
      {panel === 'notifications' && <NotificationsPanel onGo={go} />}
      {panel === 'appearance' && <AppearancePanel />}
      {panel === 'weather' && <WeatherPanel />}
      {panel === 'ai' && <ProviderSettings />}
      {panel === 'telegram' && <TelegramSettings />}
      {panel === 'accounts' && <AccountsPanel apiStatus={apiStatus} onGo={go} />}
      {panel === 'connection' && <ConnectionPanel apiStatus={apiStatus} owner={owner} />}
      {panel === 'security' && <SecurityPanel />}
      {panel === 'about' && <AboutPanel />}
      {(panel === 'memory' || panel === 'calendar') && <div className="st-legacy actual-settings-content">{panel === 'memory' ? <MemorySettings /> : <GoogleCalendarSettings />}</div>}
    </main>
  </div>
}
