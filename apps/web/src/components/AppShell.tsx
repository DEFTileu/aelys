import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { BookOpen, Calendar, Folder, House, LayoutGrid, Mail, MessageSquareText, Moon, NotebookText, Search, Settings, SquareCheck, Sun, Wallet, type AelysIconComponent } from '../icons'
import { accentColors } from '../data/desktop/settings'
import { useDesktopState, useWindowWidth, type DesktopSettings } from '../lib/desktopStore'
import { useWallpaper } from '../lib/wallpaper'
import { getSharedApiClient } from '../lib/api'
import { useOwner } from '../lib/owner'
import { usePrefs, type Prefs } from '../lib/prefs'
import { navigate } from '../lib/router'
import { dateKey, isCompleted } from '../views/tasks/taskModel'
import type { ApiStatus, RoutePath } from '../types'
import { formatDate, greetingForHour } from '../lib/format'
import { CommandPalette, pages as PALETTE_PAGES } from './CommandPalette'
import { NotificationCenter } from './NotificationCenter'
import { WeatherSettingsDialog } from './Weather'
import { AelysMark } from './AelysMark'
import { MobileShell } from './MobileShell'
import './actual-shell.css'

// Keep the wallpaper clear; fade only its lower edge into the page canvas.
const BAND_GRADIENT = {
  light: { home: 'linear-gradient(180deg,rgba(18,18,40,.18) 0,transparent 160px,transparent 356px,#F5F0EB 420px)', page: 'linear-gradient(180deg,rgba(18,18,40,.24) 0,transparent 100px,transparent 182px,#F5F0EB 230px)' },
  dark: { home: 'linear-gradient(180deg,rgba(8,6,20,.24) 0,transparent 160px,transparent 356px,#141219 420px)', page: 'linear-gradient(180deg,rgba(8,6,20,.3) 0,transparent 100px,transparent 182px,#141219 230px)' },
} as const
const DEFAULT_ACCENT = '#6A4CF2'

// Multicolor is a gradient, not a color token, so it keeps the default accent.
function accentHex(index: number): string {
  const color = accentColors[index]?.color ?? ''
  return color.startsWith('#') ? color : DEFAULT_ACCENT
}
// Tinted fills are written as plain rgba so they compute the same as the design's literal rgba(106,76,242,.12).
function accentRgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${value >> 16 & 255},${value >> 8 & 255},${value & 255},${alpha})`
}

// Shell-root custom properties read by the glass surfaces. At 70% transparency the panels keep the design's .88 alpha.
function shellVars({ transparency, blur, accent }: DesktopSettings, theme: 'light' | 'dark', glass: Prefs['glass']): CSSProperties {
  // With glass cards off the panels turn opaque and stop blurring the photo behind them.
  const alpha = glass ? Math.min(1, Math.max(0.6, 0.88 + (70 - transparency) / 300)) : 1
  return {
    '--glass-bg': theme === 'dark' ? `rgba(32,29,40,${(alpha - 0.02).toFixed(3)})` : `rgba(255,255,255,${alpha.toFixed(3)})`,
    '--sidebar-bg': theme === 'dark' ? '#18161E' : `rgba(250,247,244,${(alpha - 0.06).toFixed(3)})`,
    '--glass-blur': glass ? `${blur / 2}px` : '0px',
    '--sidebar-blur': glass ? `${blur * 0.6}px` : '0px',
    '--accent': accentHex(accent),
    '--accent-soft': accentRgba(accentHex(accent), 0.12),
  } as CSSProperties
}

type NavItem = { id: string; label: string; icon: AelysIconComponent; badge?: string; route: RoutePath }

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', icon: House, route: '/' },
  { id: 'chat', label: 'AI Chat', icon: MessageSquareText, route: '/ai' },
  { id: 'tasks', label: 'Tasks', icon: SquareCheck, route: '/tasks' },
  { id: 'calendar', label: 'Calendar', icon: Calendar, route: '/calendar' },
  { id: 'projects', label: 'Projects', icon: Folder, route: '/projects' },
  { id: 'notes', label: 'Notes', icon: NotebookText, route: '/notes' },
  { id: 'mail', label: 'Mail', icon: Mail, route: '/mail' },
  { id: 'finance', label: 'Finances', icon: Wallet, route: '/finance' },
  { id: 'kb', label: 'Knowledge base', icon: BookOpen, route: '/knowledge' },
  { id: 'utilities', label: 'Apps', icon: LayoutGrid, route: '/utilities' },
]

// Hero copy from the reference; `dated` pages show today's date above the title.
const HEROES: Partial<Record<RoutePath, { title: string; sub?: string; dated?: boolean }>> = {
  '/ai': { title: 'AI Chat', sub: 'Your personal assistant for a productive life' },
  '/tasks': { title: 'My tasks', sub: 'More focus. More results.', dated: true },
  '/calendar': { title: 'Calendar', sub: 'Plan your time. More focus \u2014 more results.', dated: true },
  '/projects': { title: 'Projects', sub: 'Everything you\u2019re building, in one view.', dated: true },
  '/notes': { title: 'Notes', sub: 'Your thoughts, ideas and plans in one place.', dated: true },
  '/mail': { title: 'Mail', sub: 'Read calmly. Draft replies when you\u2019re ready.', dated: true },
  '/finance': { title: 'Finances', sub: 'Record spending in seconds and see where it goes.', dated: true },
  '/knowledge': { title: 'Knowledge base', sub: 'Docs and references for everything you build.', dated: true },
  '/settings': { title: 'Settings', sub: 'Make Aelys your own' },
  '/utilities': { title: 'Apps', sub: 'Small tools for everything else. Pin the ones you use.' },
  '/automation': { title: 'Automation', sub: 'When this happens, Aelys does that.' },
  '/messages': { title: 'Messages', sub: 'Telegram chats. Aelys drafts, you approve.' },
  '/widgets': { title: 'Customize home' },
  '/timer': { title: 'Focus' },
  '/developer': { title: 'Developer Hub' },
  '/search': { title: 'Search' },
}

function screenFor(route: RoutePath): string | null {
  if (route === '/settings') return 'settings'
  if (route === '/timer' || route === '/automation' || route === '/messages' || route === '/developer') return 'utilities'
  return NAV.find((item) => item.route === route)?.id ?? null
}

// theme and onToggleTheme stay in the signature for App.tsx; the design has no theme toggle in the window chrome.
export function AppShell(props: { route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const width = useWindowWidth()
  return <DesktopShell {...props} mobile={width <= 700} />
}

// Open tasks due today or earlier, the same set as the Tasks "Today" tab, and unread mail. Refreshes on navigation so completing tasks updates it.
function useNavCounts(apiStatus: ApiStatus, route: RoutePath): { tasks: number; mail: number } {
  const [counts, setCounts] = useState({ tasks: 0, mail: 0 })
  useEffect(() => {
    if (apiStatus !== 'ready') return
    let active = true
    const today = dateKey(new Date().toISOString())!
    const client = getSharedApiClient()
    const tasks = Promise.resolve().then(() => client.tasks()).then((items) => items.filter((task) => !isCompleted(task) && !!task.due_at && dateKey(task.due_at)! <= today).length).catch(() => 0)
    const mail = Promise.resolve().then(() => client.mailMessages()).then((items) => items.filter((item) => item.is_read === false).length).catch(() => 0)
    void Promise.all([tasks, mail]).then(([taskCount, mailCount]) => { if (active) setCounts({ tasks: taskCount, mail: mailCount }) })
    return () => { active = false }
  }, [apiStatus, route])
  return counts
}

function DesktopShell({ route, apiStatus, children, theme, onToggleTheme, mobile }: { mobile: boolean; route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const counts = useNavCounts(apiStatus, route)
  const owner = useOwner(apiStatus)
  const settings = useDesktopState()
  const { glass, greeting } = usePrefs()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((open) => !open) }
      else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key) && PALETTE_PAGES[Number(event.key) - 1]) { event.preventDefault(); setPaletteOpen(false); navigate(PALETTE_PAGES[Number(event.key) - 1]!.route) }
      else if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const screen = screenFor(route)
  const isHome = route === '/'
  const hero = HEROES[route]
  const showGreeting = settings.homeToggles[0]
  const sideW = useWindowWidth() >= 900 ? 240 : 200
  const wallpaper = useWallpaper()
  const go = (path: RoutePath) => { setPaletteOpen(false); navigate(path) }

  const navButton = (item: NavItem) => {
    const on = item.id === screen
    const Icon = item.icon
    const badge = item.id === 'tasks' ? (counts.tasks > 0 ? String(counts.tasks) : undefined) : item.id === 'mail' ? (counts.mail > 0 ? String(counts.mail) : undefined) : item.badge
    return <button key={item.id} type="button" className={`shell-btn shell-nav-item${on ? ' shell-nav-item--on' : ''}`} aria-label={item.label} aria-current={on ? 'page' : undefined} onClick={() => go(item.route)} style={on ? { background: 'var(--accent-soft)' } : undefined}>
      <Icon size={20} aria-hidden="true" />
      <span style={{ flex: 1 }}>{item.label}</span>
      {badge && <span className="shell-nav-badge">{badge}</span>}
    </button>
  }

  return <div className={mobile ? `mobile-shell${isHome ? ' mobile-shell--home' : ''}` : 'shell-root actual-desktop'} data-screen-label={screen ?? route} style={mobile ? shellVars(settings, theme, glass) : { ...shellVars(settings, theme, glass), '--side-w': `${sideW}px`, gridTemplateColumns: `${sideW}px minmax(0,1fr)` } as CSSProperties}>
        {mobile && <MobileShell route={route} apiStatus={apiStatus} theme={theme} onToggleTheme={onToggleTheme} chromeOnly>{null}</MobileShell>}
        {!mobile && <aside className="shell-sidebar" aria-label="Main navigation">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 8px 24px' }}>
            <AelysMark />
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>Aelys</div>
              <div className="shell-brand-sub" style={{ fontSize: 12, lineHeight: '16px' }}>Personal space</div>
            </div>
          </div>
          <nav aria-label="Primary" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {NAV.map(navButton)}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8, borderRadius: 14, background: screen === 'settings' ? 'rgba(106,76,242,.10)' : 'transparent' }}>
            <div aria-hidden="true" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'radial-gradient(circle at 50% 30%,#F6C79A,#C77C5A 45%,#3A2F45 46%,#2A2438)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, lineHeight: '20px' }}>{owner.name ?? 'You'}</div>
              <div className="shell-profile-sub" style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{owner.email ?? 'Owner'}</div>
            </div>
            <button type="button" className="shell-btn shell-user-settings" title="Settings" aria-label="Settings" onClick={() => go('/settings')} style={{ width: 36, height: 36, flex: 'none', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Settings size={18} aria-hidden="true" />
            </button>
          </div>
        </aside>}

        <main className={mobile ? 'mobile-shell__content' : 'shell-main'} style={isHome || mobile ? undefined : { background: 'var(--canvas)', color: 'var(--ink)' }}>
          {!mobile && <>
            <div className="shell-photo" aria-hidden="true" style={{ height: isHome ? 420 : 230, backgroundImage: `url('${wallpaper}')` }} />
            <div className="shell-photo" aria-hidden="true" style={{ height: isHome ? 420 : 230, background: BAND_GRADIENT[theme][isHome ? 'home' : 'page'] }} />
          </>}
          <div style={{ position: 'relative' }}>
          {!mobile && <div className="actual-desktop__tools" style={{ position: 'absolute', top: 20, right: 28, display: 'flex', gap: 8, alignItems: 'center', zIndex: 2 }}>
            <button type="button" className="shell-btn shell-pill shell-pill--button" data-glass="" onClick={() => setPaletteOpen(true)} aria-label="Search or run a command" style={{ width: 260, padding: '0 8px 0 14px', gap: 10, fontSize: 13 }}>
              <Search size={18} aria-hidden="true" />
              <span style={{ flex: 1, textAlign: 'left' }}>Search or run a command</span>
              <kbd style={{ height: 24, padding: '0 8px', borderRadius: 7, fontSize: 12, lineHeight: '24px', fontFamily: 'inherit' }}>⌘K</kbd>
            </button>
            <button type="button" className="shell-btn shell-pill actual-theme" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
            <NotificationCenter apiStatus={apiStatus} route={route} />
          </div>}

          {!mobile && (isHome ? <div className="shell-hero" style={{ height: showGreeting ? 276 : 116, paddingTop: 56 }}>
            {showGreeting && <>
              <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{formatDate(new Date())}</div>
              <h1 style={{ margin: '4px 0 0', fontSize: 36, lineHeight: '44px', fontWeight: 700, letterSpacing: '-.02em' }}>{greeting === 'hello' ? 'Hello' : greetingForHour(new Date().getHours())}, {owner.name ?? 'there'}</h1>
              <div style={{ fontSize: 14, lineHeight: '22px', marginTop: 2 }}>A calm day creates bigger results.</div>
            </>}
          </div> : <div className="shell-hero" style={{ height: 140, paddingTop: 32 }}>
            {hero?.dated && <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{formatDate(new Date())}</div>}
            {hero && <h1 style={{ margin: '2px 0 0', fontSize: 30, lineHeight: '38px', fontWeight: 700, letterSpacing: '-.02em' }}>{hero.title}</h1>}
            {hero?.sub && <div style={{ fontSize: 14, lineHeight: '22px', marginTop: 2 }}>{hero.sub}</div>}
          </div>)}

          {children}
          </div>
        </main>

        {!mobile && <WeatherSettingsDialog />}
        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={go} />}
  </div>
}
