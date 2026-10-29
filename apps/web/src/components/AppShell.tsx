import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Bell, BookOpen, Calendar, CloudSun, Folder, House, LayoutGrid, Mail, MessageSquareText, NotebookText, Search, Settings, SquareCheck, Wallet, type LucideIcon } from 'lucide-react'
import { WALLPAPERS, accentColors } from '../data/desktop/settings'
import { requestCustomizeHome, useDesktopState, useWindowWidth, type DesktopSettings } from '../lib/desktopStore'
import { navigate } from '../lib/router'
import type { ApiStatus, RoutePath } from '../types'
import { CommandPalette } from './CommandPalette'

// Full-viewport layout: the wallpaper is a photo band at the top of the content column, faded into the page by these overlays.
const HOME_BG = 'linear-gradient(180deg,rgba(18,18,40,.22) 0,rgba(18,18,40,.04) 220px,rgba(246,241,236,0) 330px,rgba(246,241,236,.8) 385px,#F5F0EB 420px)'
const PAGE_BG = 'linear-gradient(180deg,rgba(18,18,40,.32) 0,rgba(18,18,40,.05) 110px,rgba(246,241,236,.75) 150px,rgba(245,240,235,.97) 230px)'
const DEFAULT_ACCENT = '#6A4CF2'

// Multicolor is a gradient, not a color token, so it keeps the default accent.
function accentHex(index: number): string {
  const color = accentColors[index]?.color ?? ''
  return color.startsWith('#') ? color : DEFAULT_ACCENT
}

// Shell-root custom properties read by the glass surfaces. At 70% transparency the panels keep the design's .88 alpha.
function shellVars({ transparency, blur, accent }: DesktopSettings): CSSProperties {
  const alpha = Math.min(1, Math.max(0.6, 0.88 + (70 - transparency) / 300))
  return {
    '--glass-bg': `rgba(255,255,255,${alpha.toFixed(3)})`,
    '--sidebar-bg': `rgba(250,247,244,${(alpha - 0.06).toFixed(3)})`,
    '--glass-blur': `${blur / 2}px`,
    '--sidebar-blur': `${blur * 0.6}px`,
    '--accent': accentHex(accent),
    '--accent-soft': 'color-mix(in srgb, var(--accent) 12%, transparent)',
  } as CSSProperties
}

type NavItem = { id: string; label: string; icon: LucideIcon; badge?: string; route: RoutePath; customize?: boolean }

const NAV: NavItem[] = [
  { id: 'home', label: 'Home', icon: House, route: '/' },
  { id: 'chat', label: 'AI Chat', icon: MessageSquareText, route: '/ai' },
  { id: 'tasks', label: 'Tasks', icon: SquareCheck, route: '/tasks' },
  { id: 'calendar', label: 'Calendar', icon: Calendar, route: '/calendar' },
  { id: 'projects', label: 'Projects', icon: Folder, route: '/projects' },
  { id: 'notes', label: 'Notes', icon: NotebookText, route: '/notes' },
  { id: 'mail', label: 'Mail', icon: Mail, badge: '12', route: '/mail' },
  { id: 'finance', label: 'Finances', icon: Wallet, route: '/finance' },
  { id: 'kb', label: 'Knowledge base', icon: BookOpen, route: '/notes' },
  { id: 'widgets', label: 'Widgets', icon: LayoutGrid, route: '/', customize: true },
]

type Hero = { title: string; sub: string; date: boolean }

const HEROES: Partial<Record<RoutePath, Hero>> = {
  '/': { title: 'Good morning, Tileuzhan', sub: 'A calm day creates bigger results.', date: true },
  '/tasks': { title: 'My tasks', sub: 'More focus. More results.', date: true },
  '/ai': { title: 'AI Chat', sub: 'Your personal assistant for a productive life', date: false },
  '/calendar': { title: 'Calendar', sub: 'Plan your time. More focus — more results.', date: true },
  '/projects': { title: 'Projects', sub: 'Everything you’re building, in one view.', date: true },
  '/notes': { title: 'Notes', sub: 'Your thoughts, ideas and plans in one place.', date: true },
  '/mail': { title: 'Mail', sub: 'Clear inbox, clear mind.', date: true },
  '/finance': { title: 'Finances', sub: 'Know where your money goes.', date: true },
  '/timer': { title: 'Timer', sub: 'One focused block at a time.', date: true },
  '/developer': { title: 'Developer Hub', sub: 'Build, test and ship with calm focus.', date: true },
  '/automation': { title: 'Automation', sub: 'Let the routine run itself.', date: true },
  '/search': { title: 'Search', sub: 'Find anything across Aelys.', date: true },
  '/settings': { title: 'Settings', sub: 'Make Aelys your own', date: false },
}

function screenFor(route: RoutePath): string | null {
  if (route === '/settings') return 'settings'
  return NAV.find((item) => item.route === route)?.id ?? null
}

// theme and onToggleTheme stay in the signature for App.tsx; the design has no theme toggle in the window chrome.
export function AppShell({ route, children }: { route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const settings = useDesktopState()
  const remaining = settings.done.filter((on) => !on).length

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((open) => !open) }
      else if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const screen = screenFor(route)
  const hero = HEROES[route]
  const isHome = screen === 'home'
  const heroDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const sideW = useWindowWidth() >= 900 ? 240 : 200
  const go = (path: RoutePath) => { setPaletteOpen(false); navigate(path) }

  return <div className="shell-root" data-screen-label={screen ?? route} style={{ ...shellVars(settings), '--side-w': `${sideW}px`, gridTemplateColumns: `${sideW}px minmax(0,1fr)` } as CSSProperties}>
        <aside className="shell-sidebar" aria-label="Main navigation">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 8px 24px' }}>
            <div aria-hidden="true" style={{ width: 40, height: 40, flex: 'none', borderRadius: 12, background: 'linear-gradient(135deg,#FF9AC8 0%,#B57BFF 45%,#5FA8FF 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 22, fontWeight: 400, boxShadow: '0 6px 16px rgba(140,90,240,.3)' }}>Λ</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>Aelys</div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: '#625D69' }}>Personal space</div>
            </div>
          </div>
          <nav aria-label="Primary" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {NAV.map((item) => {
              const on = item.id === screen
              const Icon = item.icon
              const badge = item.id === 'tasks' ? String(remaining) : item.badge
              // Widgets opens Home in Customize mode; the flag is set before navigating so Home picks it up on mount.
              const open = () => { if (item.customize) requestCustomizeHome(); go(item.route) }
              return <button key={item.id} type="button" className={`shell-btn shell-nav-item${on ? ' shell-nav-item--on' : ''}`} aria-current={on ? 'page' : undefined} onClick={open} style={on ? { background: 'var(--accent-soft)' } : undefined}>
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
        </aside>

        <main className="shell-main">
          <div className="shell-photo" aria-hidden="true" style={{ height: isHome ? 420 : 230, backgroundImage: `url('${WALLPAPERS[settings.wallpaper] ?? WALLPAPERS[0]}')` }} />
          <div className="shell-photo" aria-hidden="true" style={{ height: isHome ? 420 : 230, background: isHome ? HOME_BG : PAGE_BG }} />
          <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', top: 20, right: 28, display: 'flex', gap: 8, alignItems: 'center', zIndex: 2 }}>
            <button type="button" className="shell-btn shell-pill shell-pill--button" data-glass="" onClick={() => setPaletteOpen(true)} aria-label="Search or run a command" style={{ width: 260, padding: '0 8px 0 14px', gap: 10, fontSize: 13, color: '#625D69' }}>
              <Search size={18} color="#1C1B22" aria-hidden="true" />
              <span style={{ flex: 1, textAlign: 'left' }}>Search or run a command</span>
              <kbd style={{ height: 24, padding: '0 8px', borderRadius: 7, background: '#F1EDEA', fontSize: 12, lineHeight: '24px', color: '#3A3640', fontFamily: 'inherit' }}>⌘K</kbd>
            </button>
            <div className="shell-pill" data-glass="" style={{ padding: '0 14px', gap: 8, fontSize: 14, fontWeight: 600 }}>
              <CloudSun size={18} color="#E08A12" aria-hidden="true" />+14°
            </div>
            <button type="button" className="shell-btn shell-pill shell-pill--button" data-glass="" title="Notifications" aria-label="Notifications" style={{ position: 'relative', width: 40, justifyContent: 'center', borderRadius: '50%', padding: 0 }}>
              <Bell size={18} aria-hidden="true" />
              <span aria-hidden="true" style={{ position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: '50%', background: '#E5484D', border: '1.5px solid #fff' }} />
            </button>
          </div>

          <div className="shell-hero" style={{ height: isHome ? 276 : 140, paddingTop: isHome ? 56 : 32 }}>
            {hero?.date && <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{heroDate}</div>}
            {hero && <h1 style={{ margin: isHome ? '4px 0 0' : '2px 0 0', fontSize: isHome ? 36 : 30, lineHeight: isHome ? '44px' : '38px', fontWeight: 700, letterSpacing: '-.02em' }}>{hero.title}</h1>}
            {hero && <div style={{ fontSize: 14, lineHeight: '22px', marginTop: 2 }}>{hero.sub}</div>}
          </div>

          {children}
          </div>
        </main>

        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={go} />}
  </div>
}
