import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { BookOpen, Calendar, Folder, House, LayoutGrid, Mail, MessageSquareText, Moon, NotebookText, Search, Settings, SquareCheck, Sun, Terminal, Timer, Wallet, Workflow, type AelysIconComponent } from '../icons'
import { WALLPAPERS, accentColors } from '../data/desktop/settings'
import { useDesktopState, useWindowWidth, type DesktopSettings } from '../lib/desktopStore'
import { getSharedApiClient } from '../lib/api'
import { navigate } from '../lib/router'
import { dateKey, isCompleted } from '../views/tasks/taskModel'
import type { ApiStatus, RoutePath } from '../types'
import { isMacPlatform } from '../data/navigation'
import { formatDate, greetingForHour } from '../lib/format'
import { CommandPalette } from './CommandPalette'
import { NotificationCenter } from './NotificationCenter'
import { WeatherSettingsDialog } from './Weather'
import { AelysMark } from './AelysMark'
import { MobileShell } from './MobileShell'
import './actual-shell.css'

// Photo band gradients from the reference: Home fades out at 420px, module pages at 230px.
const BAND_GRADIENT = {
  light: { home: 'linear-gradient(180deg,rgba(18,18,40,.22) 0,rgba(18,18,40,.04) 220px,rgba(246,241,236,0) 330px,rgba(246,241,236,.8) 385px,#F5F0EB 420px)', page: 'linear-gradient(180deg,rgba(18,18,40,.32) 0,rgba(18,18,40,.05) 110px,rgba(246,241,236,.75) 150px,rgba(245,240,235,.97) 230px)' },
  dark: { home: 'linear-gradient(180deg,rgba(8,6,20,.45) 0,rgba(8,6,20,.25) 220px,rgba(20,18,25,0) 330px,rgba(20,18,25,.85) 385px,#141219 420px)', page: 'linear-gradient(180deg,rgba(8,6,20,.45) 0,rgba(8,6,20,.2) 110px,rgba(20,18,25,.8) 170px,#141219 230px)' },
} as const
const PROFILE_NAME = 'Tileuzhan'
const DEFAULT_ACCENT = '#6A4CF2'

// Multicolor is a gradient, not a color token, so it keeps the default accent.
function accentHex(index: number): string {
  const color = accentColors[index]?.color ?? ''
  return color.startsWith('#') ? color : DEFAULT_ACCENT
}

// Shell-root custom properties read by the glass surfaces. At 70% transparency the panels keep the design's .88 alpha.
function shellVars({ transparency, blur, accent }: DesktopSettings, theme: 'light' | 'dark'): CSSProperties {
  const alpha = Math.min(1, Math.max(0.6, 0.88 + (70 - transparency) / 300))
  return {
    '--glass-bg': theme === 'dark' ? `rgba(32,29,40,${alpha.toFixed(3)})` : `rgba(255,255,255,${alpha.toFixed(3)})`,
    '--sidebar-bg': theme === 'dark' ? '#1A1720' : `rgba(250,247,244,${(alpha - 0.06).toFixed(3)})`,
    '--glass-blur': `${blur / 2}px`,
    '--sidebar-blur': `${blur * 0.6}px`,
    '--accent': accentHex(accent),
    '--accent-soft': 'color-mix(in srgb, var(--accent) 12%, transparent)',
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

const TOOLS: NavItem[] = [
  { id: 'timer', label: 'Timer', icon: Timer, route: '/timer' },
  { id: 'automation', label: 'Automation', icon: Workflow, route: '/automation' },
  { id: 'developer', label: 'Developer Hub', icon: Terminal, route: '/developer' },
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
  '/widgets': { title: 'Customize home' },
  '/timer': { title: 'Focus' },
  '/developer': { title: 'Developer Hub' },
  '/search': { title: 'Search' },
}

function screenFor(route: RoutePath): string | null {
  if (route === '/settings') return 'settings'
  return [...NAV, ...TOOLS].find((item) => item.route === route)?.id ?? null
}

// theme and onToggleTheme stay in the signature for App.tsx; the design has no theme toggle in the window chrome.
export function AppShell(props: { route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const width = useWindowWidth()
  return <DesktopShell {...props} mobile={width <= 700} />
}

// Open tasks due today or earlier, the same set as the Tasks "Today" tab. Refreshes on navigation so completing tasks updates it.
function useTodayTaskCount(apiStatus: ApiStatus, route: RoutePath): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (apiStatus !== 'ready') return
    let active = true
    const today = dateKey(new Date().toISOString())!
    getSharedApiClient().tasks().then((tasks) => { if (active) setCount(tasks.filter((task) => !isCompleted(task) && !!task.due_at && dateKey(task.due_at)! <= today).length) }).catch(() => { if (active) setCount(0) })
    return () => { active = false }
  }, [apiStatus, route])
  return count
}

function DesktopShell({ route, apiStatus, children, theme, onToggleTheme, mobile }: { mobile: boolean; route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const todayTasks = useTodayTaskCount(apiStatus, route)
  const settings = useDesktopState()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((open) => !open) }
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
  const wallpaper = settings.wallpaper === -1 && settings.customWallpaper ? settings.customWallpaper : WALLPAPERS[settings.wallpaper] ?? WALLPAPERS[0]
  const go = (path: RoutePath) => { setPaletteOpen(false); navigate(path) }

  const navButton = (item: NavItem) => {
    const on = item.id === screen
    const Icon = item.icon
    const badge = item.id === 'tasks' ? (todayTasks > 0 ? String(todayTasks) : undefined) : item.badge
    return <button key={item.id} type="button" className={`shell-btn shell-nav-item${on ? ' shell-nav-item--on' : ''}`} aria-label={item.label} aria-current={on ? 'page' : undefined} onClick={() => go(item.route)} style={on ? { background: 'var(--accent-soft)' } : undefined}>
      <Icon size={20} aria-hidden="true" />
      <span style={{ flex: 1 }}>{item.label}</span>
      {badge && <span className="shell-nav-badge">{badge}</span>}
    </button>
  }

  return <div className={mobile ? `mobile-shell${isHome ? ' mobile-shell--home' : ''}` : 'shell-root actual-desktop'} data-screen-label={screen ?? route} style={mobile ? shellVars(settings, theme) : { ...shellVars(settings, theme), '--side-w': `${sideW}px`, gridTemplateColumns: `${sideW}px minmax(0,1fr)` } as CSSProperties}>
        {mobile && <MobileShell route={route} apiStatus={apiStatus} theme={theme} onToggleTheme={onToggleTheme} chromeOnly>{null}</MobileShell>}
        {!mobile && <aside className="shell-sidebar" aria-label="Main navigation">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 8px 24px' }}>
            <AelysMark />
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>Aelys</div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: '#625D69' }}>Personal space</div>
            </div>
          </div>
          <nav aria-label="Primary" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {NAV.map(navButton)}
          </nav>
          <div className="shell-nav-group" role="presentation" style={{ margin: '16px 8px 6px', fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#625D69' }}>Tools</div>
          <nav aria-label="Tools" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {TOOLS.filter((item) => item.id !== 'developer' || isMacPlatform()).map(navButton)}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8, borderRadius: 14, background: screen === 'settings' ? 'rgba(106,76,242,.10)' : 'transparent' }}>
            <div aria-hidden="true" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'radial-gradient(circle at 50% 30%,#F6C79A,#C77C5A 45%,#3A2F45 46%,#2A2438)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, lineHeight: '20px' }}>{PROFILE_NAME}</div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: '#625D69', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Student · Developer</div>
            </div>
            <button type="button" className="shell-btn shell-user-settings" title="Settings" aria-label="Settings" onClick={() => go('/settings')} style={{ width: 36, height: 36, flex: 'none', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3A3640' }}>
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
            <button type="button" className="shell-btn shell-pill shell-pill--button" data-glass="" onClick={() => setPaletteOpen(true)} aria-label="Search or run a command" style={{ width: 260, padding: '0 8px 0 14px', gap: 10, fontSize: 13, color: '#625D69' }}>
              <Search size={18} color="#1C1B22" aria-hidden="true" />
              <span style={{ flex: 1, textAlign: 'left' }}>Search or run a command</span>
              <kbd style={{ height: 24, padding: '0 8px', borderRadius: 7, background: '#F1EDEA', fontSize: 12, lineHeight: '24px', color: '#3A3640', fontFamily: 'inherit' }}>⌘K</kbd>
            </button>
            <button type="button" className="shell-btn shell-pill actual-theme" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
            <NotificationCenter apiStatus={apiStatus} route={route} />
          </div>}

          {!mobile && (isHome ? <div className="shell-hero" style={{ height: showGreeting ? 276 : 116, paddingTop: 56 }}>
            {showGreeting && <>
              <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{formatDate(new Date())}</div>
              <h1 style={{ margin: '4px 0 0', fontSize: 36, lineHeight: '44px', fontWeight: 700, letterSpacing: '-.02em' }}>{greetingForHour(new Date().getHours())}, {PROFILE_NAME}</h1>
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
