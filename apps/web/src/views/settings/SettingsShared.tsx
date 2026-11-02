import { ChevronLeft, ChevronRight, Search } from '../../icons'
import { AppearancePanel } from './AppearancePanel'
import { AboutPanel, ConnectionPanel, NotificationsPanel, ProfilePanel, SecurityPanel } from './panels'
import { WeatherPanel } from './WeatherPanel'
import { GoogleCalendarSettings } from '../GoogleCalendarSettings'
import { MemorySettings } from '../MemorySettings'
import { ProviderSettings } from '../ProviderSettings'
import { TelegramSettings } from '../TelegramSettings'
import type { SettingsState } from './useSettings'

// The search field and the grouped section list are the same on phone and desktop; only the frame around them differs.
export function SettingsSearch({ t }: { t: SettingsState }) {
  return <label className="st-search"><Search size={14} aria-hidden="true" /><input aria-label="Search settings" placeholder="Search settings" value={t.query} onChange={(event) => t.setQuery(event.target.value)} /></label>
}

export function SettingsNavList({ t }: { t: SettingsState }) {
  return <nav aria-label="Settings sections" style={{ display: 'contents' }}>
    {t.groups.map((group) => <section key={group.title} style={{ display: 'contents' }} aria-label={group.title}>
      <div className="st-nav-group">{group.title}</div>
      <div className="st-nav-list">
        {group.items.map((item) => { const NavIcon = item.icon; return <button key={item.id} type="button" className="st-nav-item" data-section={item.id} aria-current={t.panel === item.id ? 'page' : undefined} onClick={() => t.go(item.id)}>
          <span className={`st-tile st-tone-${item.tone}`}><NavIcon size={14} aria-hidden="true" /></span>
          <span className="st-nav-text"><span>{item.title}</span><span className="st-nav-desc">{item.desc}</span></span>
          <ChevronRight className="st-nav-chevron" size={14} aria-hidden="true" />
        </button> })}
      </div>
    </section>)}
    {!t.groups.length && <p className="st-nav-empty">No settings sections found.</p>}
  </nav>
}

// Head and panel body, without the surrounding frame.
export function SettingsBody({ t }: { t: SettingsState }) {
  const { current, panel, go, owner, apiStatus } = t
  return <>
    <div className="st-head">
      <button type="button" className="st-back" aria-label="Back to settings" onClick={() => t.setOpen(false)}><ChevronLeft size={20} aria-hidden="true" /></button>
      <div><h2 className="st-title">{current.title}</h2><div className="st-sub">{current.desc}</div></div>
    </div>
    {panel === 'profile' && <ProfilePanel owner={owner} />}
    {panel === 'notifications' && <NotificationsPanel onGo={go} />}
    {panel === 'appearance' && <AppearancePanel />}
    {panel === 'weather' && <WeatherPanel />}
    {panel === 'ai' && <ProviderSettings />}
    {panel === 'telegram' && <TelegramSettings />}
    {panel === 'connection' && <ConnectionPanel apiStatus={apiStatus} owner={owner} />}
    {panel === 'security' && <SecurityPanel />}
    {panel === 'about' && <AboutPanel />}
    {(panel === 'memory' || panel === 'calendar') && <div className="st-legacy actual-settings-content">{panel === 'memory' ? <MemorySettings /> : <GoogleCalendarSettings />}</div>}
  </>
}
