import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { BookOpen, Calendar, Folder, House, LayoutGrid, Mail, MessageSquareText, Moon, NotebookText, Search, Settings, SquareCheck, Sun, Wallet, type AelysIconComponent } from '../icons'
import { WALLPAPERS, accentColors } from '../data/desktop/settings'
import { requestCustomizeHome, useDesktopState, useWindowWidth, type DesktopSettings } from '../lib/desktopStore'
import { getSharedApiClient } from '../lib/api'
import { navigate } from '../lib/router'
import { dateKey, isCompleted } from '../views/tasks/taskModel'
import type { ApiStatus, RoutePath } from '../types'
import { CommandPalette } from './CommandPalette'
import { NotificationCenter } from './NotificationCenter'
import { WeatherPill, WeatherSettingsDialog } from './Weather'
import { AelysMark } from './AelysMark'
import { MobileShell } from './MobileShell'
import './actual-shell.css'

// The home page keeps its wallpaper; module pages use the neutral theme canvas.
const HOME_BG = 'linear-gradient(180deg,rgba(18,18,40,.22) 0,rgba(18,18,40,.04) 220px,rgba(246,241,236,0) 330px,rgba(246,241,236,.8) 385px,#F5F0EB 420px)'
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
    '--glass-bg': theme === 'dark' ? `rgba(35,34,53,${alpha.toFixed(3)})` : `rgba(255,255,255,${alpha.toFixed(3)})`,
    '--sidebar-bg': theme === 'dark' ? '#1b1928' : `rgba(250,247,244,${(alpha - 0.06).toFixed(3)})`,
    '--glass-blur': `${blur / 2}px`,
    '--sidebar-blur': `${blur * 0.6}px`,
    '--accent': accentHex(accent),
    '--accent-soft': 'color-mix(in srgb, var(--accent) 12%, transparent)',
  } as CSSProperties
}

type NavItem = { id: string; label: string; icon: AelysIconComponent; badge?: string; route: RoutePath; customize?: boolean }

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
  { id: 'widgets', label: 'Widgets', icon: LayoutGrid, route: '/', customize: true },
]

const MODULE_TITLES: Partial<Record<RoutePath, string>> = {
  '/ai': 'AI Chat',
  '/calendar': 'Calendar',
  '/tasks': 'Tasks',
  '/widgets': 'Customize home',
  '/projects': 'Projects',
  '/notes': 'Notes',
  '/knowledge': 'Knowledge base',
  '/mail': 'Mail',
  '/finance': 'Finances',
  '/timer': 'Timer',
  '/developer': 'Developer Hub',
  '/automation': 'Automation',
  '/search': 'Search',
  '/settings': 'Settings',
}

function screenFor(route: RoutePath): string | null {
  if (route === '/settings') return 'settings'
  return NAV.find((item) => item.route === route)?.id ?? null
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
  const showGreeting = settings.homeToggles[0]
  const sideW = useWindowWidth() >= 900 ? 240 : 200
  const wallpaper = settings.wallpaper === -1 && settings.customWallpaper ? settings.customWallpaper : WALLPAPERS[settings.wallpaper] ?? WALLPAPERS[0]
  const go = (path: RoutePath) => { setPaletteOpen(false); navigate(path) }

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
            {NAV.map((item) => {
              const on = item.id === screen
              const Icon = item.icon
              const badge = item.id === 'tasks' ? (todayTasks > 0 ? String(todayTasks) : undefined) : item.badge
              // Widgets opens Home in Customize mode; the flag is set before navigating so Home picks it up on mount.
              const open = () => { if (item.customize) requestCustomizeHome(); go(item.route) }
              return <button key={item.id} type="button" className={`shell-btn shell-nav-item${on ? ' shell-nav-item--on' : ''}`} aria-label={item.label} aria-current={on ? 'page' : undefined} onClick={open} style={on ? { background: 'var(--accent-soft)' } : undefined}>
                <Icon size={20} aria-hidden="true" />
                <span style={{ flex: 1 }}>{item.label}</span>
                {badge && <span className="shell-nav-badge">{badge}</span>}
              </button>
            })}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8, borderRadius: 14, background: screen === 'settings' ? 'rgba(106,76,242,.10)' : 'transparent' }}>
            <div aria-hidden="true" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', background: 'radial-gradient(circle at 50% 30%,#F6C79A,#C77C5A 45%,#3A2F45 46%,#2A2438)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, lineHeight: '20px' }}>Tileuzhan</div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: '#625D69', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Student · Developer</div>
            </div>
            <button type="button" className="shell-btn shell-user-settings" title="Settings" aria-label="Settings" onClick={() => go('/settings')} style={{ width: 36, height: 36, flex: 'none', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3A3640' }}>
              <Settings size={18} aria-hidden="true" />
            </button>
          </div>
        </aside>}

        <main className={mobile ? 'mobile-shell__content' : 'shell-main'} style={isHome || mobile ? undefined : { background: 'var(--canvas)', color: 'var(--ink)' }}>
          {!mobile && isHome && <>
            <div className="shell-photo" aria-hidden="true" style={{ height: 420, backgroundImage: `url('${wallpaper}')` }} />
            <div className="shell-photo" aria-hidden="true" style={{ height: 420, background: theme === 'dark' ? 'linear-gradient(180deg,rgba(18,18,40,.22),rgba(21,20,31,.15) 220px,#15141F 420px)' : HOME_BG }} />
          </>}
          <div style={{ position: 'relative' }}>
          {!mobile && <div className="actual-desktop__tools" style={{ position: 'absolute', top: 20, right: 28, display: 'flex', gap: 8, alignItems: 'center', zIndex: 2 }}>
            <button type="button" className="shell-btn shell-pill shell-pill--button" data-glass="" onClick={() => setPaletteOpen(true)} aria-label="Search or run a command" style={{ width: 260, padding: '0 8px 0 14px', gap: 10, fontSize: 13, color: '#625D69' }}>
              <Search size={18} color="#1C1B22" aria-hidden="true" />
              <span style={{ flex: 1, textAlign: 'left' }}>Search or run a command</span>
              <kbd style={{ height: 24, padding: '0 8px', borderRadius: 7, background: '#F1EDEA', fontSize: 12, lineHeight: '24px', color: '#3A3640', fontFamily: 'inherit' }}>⌘K</kbd>
            </button>
            <WeatherPill />
            <button type="button" className="shell-btn shell-pill actual-theme" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
            <NotificationCenter apiStatus={apiStatus} route={route} />
          </div>}

          {!mobile && (isHome ? <div className="shell-hero" style={{ height: showGreeting ? 276 : 116, paddingTop: 80 }}>
            {showGreeting && <h1 style={{ margin: '4px 0 0', fontSize: 36, lineHeight: '44px', fontWeight: 700, letterSpacing: '-.02em' }}>Home</h1>}
          </div> : <div className="shell-hero" style={{ height: 132, paddingTop: 80, color: 'var(--ink)', textShadow: 'none' }}>
            {MODULE_TITLES[route] && <h1 style={{ margin: '2px 0 0', fontSize: 30, lineHeight: '38px', fontWeight: 700, letterSpacing: '-.02em' }}>{MODULE_TITLES[route]}</h1>}
          </div>)}

          {children}
          </div>
        </main>

        {!mobile && <WeatherSettingsDialog />}
        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={go} />}
  </div>
}
