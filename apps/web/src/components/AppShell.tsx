import { useState, type ReactNode } from 'react'
import { appNav, primaryNav, utilityNav, type NavItem } from '../data/navigation'
import { navigate } from '../lib/router'
import type { ApiStatus, RoutePath } from '../types'
import { ApiStatusPill } from './ApiStatusPill'
import { Icon } from './Icon'
import { AiCommandBar } from './AiCommandBar'

function NavLink({ item, route, onNavigate, compact = false }: { item: NavItem; route: RoutePath; onNavigate: (path: RoutePath) => void; compact?: boolean }) {
  const active = route === item.path
  return <button className={`nav-link ${active ? 'nav-link--active' : ''} ${compact ? 'nav-link--compact' : ''}`} onClick={() => onNavigate(item.path)} aria-current={active ? 'page' : undefined} title={compact ? item.label : undefined}>
    <Icon name={item.icon as never} size={18} />
    {!compact && <span>{item.label}</span>}
    {!compact && item.badge && <span className="nav-link__badge">{item.badge}</span>}
  </button>
}

export function AppShell({ route, apiStatus, theme, onToggleTheme, children }: { route: RoutePath; apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void; children: ReactNode }) {
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)

  const go = (path: RoutePath) => {
    navigate(path)
    setLauncherOpen(false)
  }

  return <div className={`app-shell ${route === '/' ? 'app-shell--home' : ''} ${railCollapsed ? 'app-shell--rail-collapsed' : ''}`}>
    <aside className="sidebar" aria-label="Main navigation">
      <div className="window-controls" aria-hidden="true"><span /><span /><span /></div>
      <div className="brand-row">
        <button className="brand" onClick={() => go('/')} aria-label="Go to Aelys home">
          <span className="brand-mark"><span>Λ</span></span>
          {!railCollapsed && <span><strong>Aelys</strong><small>Personal space</small></span>}
        </button>
        <button className="icon-button sidebar-toggle" onClick={() => setRailCollapsed((value) => !value)} aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}><Icon name="menu" size={18} /></button>
      </div>
      <nav className="nav-section" aria-label="Primary">
        {!railCollapsed && <p className="nav-label">Workspace</p>}
        {primaryNav.map((item) => <NavLink key={item.path} item={item} route={route} onNavigate={go} compact={railCollapsed} />)}
      </nav>
      <nav className="nav-section nav-section--apps" aria-label="Applications">
        {!railCollapsed && <p className="nav-label">Applications</p>}
        {appNav.map((item) => <NavLink key={item.path} item={item} route={route} onNavigate={go} compact={railCollapsed} />)}
      </nav>
      <div className="sidebar-spacer" />
      <nav className="nav-section" aria-label="Utilities">
        {utilityNav.map((item) => <NavLink key={item.path} item={item} route={route} onNavigate={go} compact={railCollapsed} />)}
      </nav>
      <div className="sidebar-footer">
        {!railCollapsed && <div className="workspace-note"><span className="avatar">T</span><span><strong>Tileuzhan</strong><small>Student · Developer</small></span><button className="icon-button" onClick={() => go('/settings')} aria-label="Open settings"><Icon name="settings" size={17} /></button></div>}
      </div>
    </aside>

    <div className="mobile-header">
      <button className="brand" onClick={() => go('/')} aria-label="Go to Aelys home"><span className="brand-mark"><span>✦</span></span><span><strong>Aelys</strong><small>Personal OS</small></span></button>
      <div className="mobile-header__actions"><button className="icon-button" onClick={() => setLauncherOpen(true)} aria-label="Open applications"><Icon name="grid" size={20} /></button><button className="icon-button" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button></div>
    </div>

    <main className="main-content">
      <div className="desktop-toolbar"><button className="top-command" type="button" aria-label="Search or run a command"><Icon name="search" size={17} /><span>Search or run a command</span><kbd>⌘K</kbd></button><span className="top-weather"><Icon name="sun" size={17} />+14°</span><button className="top-notification" type="button" aria-label="Notifications"><Icon name="bell" size={17} /><i /></button><button className="icon-button theme-button" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button></div>
      {children}
    </main>

    <div className="mobile-ai-dock"><AiCommandBar compact /></div>
    {launcherOpen && <div className="launcher-backdrop" role="presentation" onClick={() => setLauncherOpen(false)}>
      <section className="launcher" role="dialog" aria-modal="true" aria-labelledby="launcher-title" onClick={(event) => event.stopPropagation()}>
        <div className="launcher__header"><div><p className="eyebrow">Aelys</p><h2 id="launcher-title">Applications</h2></div><button className="icon-button" onClick={() => setLauncherOpen(false)} aria-label="Close applications"><Icon name="x" size={20} /></button></div>
        <div className="launcher__grid">{[...primaryNav, ...appNav, ...utilityNav].map((item) => <button key={item.path} className="launcher-tile" onClick={() => go(item.path)}><span className="launcher-tile__icon"><Icon name={item.icon as never} size={20} /></span><span>{item.label}</span></button>)}</div>
      </section>
    </div>}
  </div>
}
