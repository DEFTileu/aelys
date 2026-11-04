import { ChevronRight, Search } from '../../icons'
import type { ApiStatus } from '../../types'
import { AppearancePanel } from './AppearancePanel'
import { AboutPanel, ConnectionPanel, NotificationsPanel, ProfilePanel, SecurityPanel } from './panels'
import { WeatherPanel } from './WeatherPanel'
import { AccountsPanel } from './AccountsPanel'
import { GoogleCalendarSettings } from '../GoogleCalendarSettings'
import { MemorySettings } from '../MemorySettings'
import { ProviderSettings } from '../ProviderSettings'
import { TelegramSettings } from '../TelegramSettings'
import '../actual-settings.css'
import './settings.css'
import { useSettings } from './useSettings'

export function SettingsMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const { owner, open, query, setQuery, groups, panel, go, current } = useSettings(apiStatus)

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
