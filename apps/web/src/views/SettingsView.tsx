import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { getApiConfig, logout, saveApiBaseUrl } from '../lib/api'
import { SettingsScreen } from './desktop/SettingsScreen'
import { ProviderSettings } from './ProviderSettings'
import { WeatherSettingsContent } from '../components/Weather'
import { TelegramSettings } from './TelegramSettings'
import { navigate } from '../lib/router'
import { BiometricSettings } from '../components/BiometricSettings'
import { isKeychainAccessRequired, isNativeHost, KEYCHAIN_ACCESS_NOTICE } from '../lib/nativeTransport'
import type { ApiStatus } from '../types'
import { Blocks, CloudSun, Wifi, Paintbrush, Search, Shield, Sparkles, Send } from '../icons'
import './actual-settings.css'

export function SettingsView({ apiStatus, theme, onToggleTheme }: { apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [baseUrl, setBaseUrl] = useState(getApiConfig().baseUrl)
  const [saved, setSaved] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [mobilePanelOpen, setMobilePanelOpen] = useState(() => new URLSearchParams(window.location.search).get('section') === 'telegram')
  const [panel, setPanel] = useState<'connection' | 'appearance' | 'ai' | 'weather' | 'telegram' | 'security'>(() => new URLSearchParams(window.location.search).get('section') === 'telegram' ? 'telegram' : 'appearance')

  const save = (event: FormEvent) => {
    event.preventDefault()
    saveApiBaseUrl(baseUrl)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2200)
  }

  const signOut = async () => {
    if (authBusy) return
    setAuthBusy(true); setAuthMessage('')
    try { await logout(); setAuthMessage('Вы вышли из Aelys.') }
    catch (error) {
      const code = error instanceof Error ? error.message : error
      setAuthMessage(isKeychainAccessRequired(error) ? KEYCHAIN_ACCESS_NOTICE : code === 'LOCAL_LOGOUT_ONLY' ? 'Вы вышли на этом устройстве. Сервер не подтвердил отзыв сессии.' : isNativeHost() ? 'Не удалось выйти. Повторите попытку.' : 'Локальный выход выполнен. Сервер недоступен.')
    } finally { setAuthBusy(false) }
  }

  const sections = [
    { id: 'appearance' as const, title: 'Appearance', subtitle: 'Theme, wallpaper, styling', icon: Paintbrush },
    { id: 'connection' as const, title: 'Connection', subtitle: 'API and owner session', icon: Wifi },
    { id: 'ai' as const, title: 'AI & models', subtitle: 'Providers and models', icon: Sparkles },
    { id: 'weather' as const, title: 'Погода и город', subtitle: 'Weather and city', icon: CloudSun },
    { id: 'telegram' as const, title: 'Telegram', subtitle: 'Connected messaging', icon: Send },
    ...(isNativeHost() ? [{ id: 'security' as const, title: 'Безопасность', subtitle: 'Security and biometric access', icon: Shield }] : []),
  ]
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = (text: string) => text.toLocaleLowerCase().includes(normalizedQuery)
  const visibleSections = sections.filter((item) => matches(`${item.title} ${item.subtitle}`))
  const showComponents = matches('Компоненты Components')
  const connection = <div className="actual-connection">
    <header className="actual-connection-header"><div><h2>Connection</h2><p>API and owner session</p></div><ApiStatusPill status={apiStatus} /></header>
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>API connection</h2></div><Icon name="external" size={19} /></div>
      <form onSubmit={save} className="settings-form"><label>API base URL<input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setSaved(false) }} placeholder="/api/v1" inputMode="url" /></label><p className="field-help">Default: <code>/api/v1</code>. Build-time setting: <code>VITE_API_BASE_URL</code>.</p><button className="button button--primary" type="submit"><Icon name="refresh" size={16} />Save connection</button>{saved && <span className="save-note" role="status">Saved locally. Reload to check the new endpoint.</span>}</form>
    </section>
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>Owner session</h2></div><Icon name="lock" size={19} /></div>
      <div className="settings-form"><button className="button button--quiet" type="button" disabled={authBusy} onClick={() => void signOut()}>{authBusy ? 'Выходим…' : 'Sign out'}</button>{authMessage && <span role="status">{authMessage}</span>}</div>
    </section>
  </div>

  return <div className={`actual-settings ${mobilePanelOpen ? 'actual-settings--mobile-panel' : ''}`}>
    <aside className="actual-settings-nav">
      <label className="actual-settings-search"><Search size={16} aria-hidden="true" /><input aria-label="Search settings" placeholder="Search settings…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="actual-settings-mobile-heading">Settings</div><nav aria-label="Settings sections">
        {visibleSections.map((item) => { const NavIcon = item.icon; return <button key={item.id} type="button" aria-current={panel === item.id ? 'page' : undefined} onClick={() => { setPanel(item.id); setMobilePanelOpen(true) }}><span className="actual-settings-nav-icon"><NavIcon size={20} aria-hidden="true" /></span><span className="actual-settings-nav-label"><strong>{item.title}</strong><small>{item.subtitle}</small></span><span className="actual-settings-chevron" aria-hidden="true">›</span></button> })}
        {showComponents && <a href="/components" onClick={(event) => { event.preventDefault(); navigate('/components') }}><Blocks size={20} aria-hidden="true" /><span><strong>Компоненты</strong><small>Components</small></span></a>}
        {!visibleSections.length && !showComponents && <p>No settings sections found.</p>}
      </nav>
    </aside>
    <main className="actual-settings-content"><button type="button" className="actual-settings-back" onClick={() => setMobilePanelOpen(false)}>← Settings</button>
      {panel === 'appearance' && <SettingsScreen theme={theme} onToggleTheme={onToggleTheme} />}
      {panel === 'connection' && connection}
      {panel === 'ai' && <ProviderSettings />}
      {panel === 'weather' && <section className="settings-card weather-settings-page"><h2>Погода и город</h2><WeatherSettingsContent /></section>}
      {panel === 'telegram' && <TelegramSettings />}
      {panel === 'security' && isNativeHost() && <BiometricSettings />}
    </main>
  </div>
}
