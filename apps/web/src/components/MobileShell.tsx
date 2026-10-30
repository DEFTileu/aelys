import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowUp, BookOpen, Calendar, Folder, LayoutGrid, Mail, MessageSquareText, NotebookText, Search, Settings, Sparkles, SquareCheck, Terminal, Timer, User, Wallet, Workflow, X, type AelysIconComponent } from '../icons'
import { WALLPAPERS } from '../data/desktop/settings'
import { askAelys, requestCustomizeHome, useDesktopState } from '../lib/desktopStore'
import { navigate } from '../lib/router'
import type { ApiStatus, RoutePath } from '../types'
import { AelysMark } from './AelysMark'
import { NotificationCenter } from './NotificationCenter'
import { WeatherPill, WeatherSettingsDialog } from './Weather'
import './mobile-shell.css'

type App = { label: string; route: RoutePath; icon: AelysIconComponent; color: string }
const APPS: App[] = [
  { label: 'Tasks', route: '/tasks', icon: SquareCheck, color: 'blue' },
  { label: 'Calendar', route: '/calendar', icon: Calendar, color: 'red' },
  { label: 'Projects', route: '/projects', icon: Folder, color: 'green' },
  { label: 'Notes', route: '/notes', icon: NotebookText, color: 'orange' },
  { label: 'Mail', route: '/mail', icon: Mail, color: 'violet' },
  { label: 'Finances', route: '/finance', icon: Wallet, color: 'green' },
  { label: 'AI Chat', route: '/ai', icon: MessageSquareText, color: 'violet' },
  { label: 'Settings', route: '/settings', icon: Settings, color: 'gray' },
  { label: 'Search', route: '/search', icon: Search, color: 'blue' },
  { label: 'Knowledge base', route: '/knowledge', icon: BookOpen, color: 'orange' },
  { label: 'Timer', route: '/timer', icon: Timer, color: 'red' },
  { label: 'Developer Hub', route: '/developer', icon: Terminal, color: 'gray' },
  { label: 'Automation', route: '/automation', icon: Workflow, color: 'blue' },
  { label: 'Widgets', route: '/widgets', icon: LayoutGrid, color: 'violet' },
  { label: 'Components', route: '/components', icon: LayoutGrid, color: 'gray' },
]


export function MobileShell({ route, apiStatus, children, chromeOnly = false }: { chromeOnly?: boolean; route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const settings = useDesktopState()
  const [appsOpen, setAppsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLElement>(null)
  const isHome = route === '/'
  const wallpaper = settings.wallpaper === -1 && settings.customWallpaper ? settings.customWallpaper : WALLPAPERS[settings.wallpaper] ?? WALLPAPERS[0]
  const title = APPS.find((app) => app.route === route)?.label ?? 'Aelys'

  useEffect(() => { setAppsOpen(false) }, [route])
  useEffect(() => {
    if (!appsOpen) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    sheet.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setAppsOpen(false); return }
      if (event.key !== 'Tab') return
      const buttons = sheet.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (previouslyFocused?.isConnected) previouslyFocused.focus() }
  }, [appsOpen])

  const go = (path: RoutePath) => { setAppsOpen(false); if (path === '/widgets') { requestCustomizeHome(); navigate('/') } else navigate(path) }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (text) { setDraft(''); askAelys(text) } else go('/ai')
  }

  return <div style={chromeOnly ? { display: 'contents' } : undefined} className={chromeOnly ? undefined : `mobile-shell${isHome ? ' mobile-shell--home' : ''}`}>
    {isHome && <div className="mobile-shell__wallpaper" aria-hidden="true" style={{ backgroundImage: `url(${JSON.stringify(wallpaper)})` }} />}
    <header className="mobile-shell__header">
      {isHome ? <><AelysMark size={36} /><strong className="mobile-shell__brand">Aelys</strong></> : <><button className="mobile-shell__circle" type="button" aria-label="Back to Home" onClick={() => go('/')}><ArrowLeft size={20} /></button><strong className="mobile-shell__title">{title}</strong></>}
      {isHome && <><button ref={trigger} className="mobile-shell__circle" type="button" aria-label="All apps" aria-expanded={appsOpen} onClick={() => setAppsOpen(true)}><LayoutGrid size={18} /></button><button className="mobile-shell__circle" type="button" aria-label="Search" onClick={() => go('/search')}><Search size={18} /></button><NotificationCenter apiStatus={apiStatus} route={route} /></>}
      {!isHome && <button ref={trigger} className="mobile-shell__circle" type="button" aria-label="All apps" aria-expanded={appsOpen} onClick={() => setAppsOpen(true)}><LayoutGrid size={18} /></button>}
      <button className="mobile-shell__profile" type="button" aria-label="Profile and settings" onClick={() => go('/settings')}><User size={18} /></button>
    </header>
    {isHome && <div className="mobile-shell__weather"><WeatherPill /></div>}
    {!chromeOnly && <main className="mobile-shell__content">{children}</main>}
    <div className="mobile-shell__bottom">
      {isHome && <form className="mobile-shell__ask" onSubmit={submit}><label className="mobile-shell__ask-field"><span className="mobile-shell__sr-only">Ask Aelys</span><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask or search" /></label><button className="mobile-shell__orb" type="submit" aria-label={draft.trim() ? 'Send to Aelys' : 'Open AI Chat'}>{draft.trim() ? <ArrowUp size={21} /> : <Sparkles size={21} />}</button></form>}
      {!isHome && route !== '/ai' && <button className="mobile-shell__orb mobile-shell__fab" type="button" aria-label="Open AI Chat" onClick={() => go('/ai')}><Sparkles size={21} /></button>}
    </div>
    {appsOpen && <div className="mobile-shell__overlay"><div className="mobile-shell__backdrop" onClick={() => setAppsOpen(false)} aria-hidden="true" /><section ref={sheet} className="mobile-shell__sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-apps-title"><div className="mobile-shell__handle" /><div className="mobile-shell__sheet-head"><h2 id="mobile-apps-title">All apps</h2><button type="button" className="mobile-shell__close" aria-label="Close all apps" onClick={() => setAppsOpen(false)}><X size={18} /></button></div><div className="mobile-shell__apps">{APPS.map(({ label, route: path, icon: Icon, color }) => <button key={path} type="button" onClick={() => go(path)}><span className={`mobile-shell__app-icon mobile-shell__app-icon--${color}`}><Icon size={20} /></span><span>{label}</span></button>)}</div></section></div>}
    <WeatherSettingsDialog />
  </div>
}
