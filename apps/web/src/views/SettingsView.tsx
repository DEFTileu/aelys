import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { getAccessToken, getApiConfig, logout, saveApiBaseUrl } from '../lib/api'
import { SettingsScreen } from './desktop/SettingsScreen'
import { ProviderSettings } from './ProviderSettings'
import { WeatherSettingsContent } from '../components/Weather'
import { TelegramSettings } from './TelegramSettings'
import { navigate } from '../lib/router'
import { BiometricSettings } from '../components/BiometricSettings'
import { isKeychainAccessRequired, isNativeHost, KEYCHAIN_ACCESS_NOTICE } from '../lib/nativeTransport'
import type { ApiStatus } from '../types'

export function SettingsView({ apiStatus, theme, onToggleTheme }: { apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [baseUrl, setBaseUrl] = useState(getApiConfig().baseUrl)
  const [saved, setSaved] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [panel, setPanel] = useState<'connection' | 'appearance' | 'ai' | 'weather' | 'telegram' | 'security'>(() => new URLSearchParams(window.location.search).get('section') === 'telegram' ? 'telegram' : getAccessToken() ? 'appearance' : 'connection')

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

  const panels = <nav className="pill-tabs settings-panels" aria-label="Settings sections">
    <a className="pill-tab" href="/components" style={{ textDecoration: 'none' }} onClick={(event) => { event.preventDefault(); navigate('/components') }}>Компоненты</a>
    <button className={`pill-tab ${panel === 'appearance' ? 'pill-tab--active' : ''}`} aria-pressed={panel === 'appearance'} type="button" onClick={() => setPanel('appearance')}>Appearance</button>
    <button className={`pill-tab ${panel === 'connection' ? 'pill-tab--active' : ''}`} aria-pressed={panel === 'connection'} type="button" onClick={() => setPanel('connection')}>Connection</button>
    <button className={`pill-tab ${panel === 'ai' ? 'pill-tab--active' : ''}`} aria-pressed={panel === 'ai'} type="button" onClick={() => setPanel('ai')}>AI &amp; models</button>
    <button className={`pill-tab ${panel === 'weather' ? 'pill-tab--active' : ''}`} aria-pressed={panel === 'weather'} type="button" onClick={() => setPanel('weather')}>Погода и город</button>
    <button className={`pill-tab ${panel === 'telegram' ? 'pill-tab--active' : ''}`} aria-pressed={panel === 'telegram'} type="button" onClick={() => setPanel('telegram')}>Telegram</button>
    {isNativeHost() && <button className={`pill-tab ${panel === 'security' ? 'pill-tab--active' : ''}`} aria-pressed={panel === 'security'} type="button" onClick={() => setPanel('security')}>Безопасность</button>}
  </nav>

  if (panel === 'telegram') return <>{panels}<TelegramSettings /></>
  if (panel === 'security' && isNativeHost()) return <>{panels}<BiometricSettings /></>
  if (panel === 'weather') return <>{panels}<section className="settings-card weather-settings-page"><h2>Погода и город</h2><WeatherSettingsContent /></section></>
  if (panel === 'ai') return <>{panels}<ProviderSettings /></>
  if (panel === 'appearance') return <>{panels}<SettingsScreen theme={theme} onToggleTheme={onToggleTheme} onOpenAI={() => setPanel('ai')} /></>

  return <>{panels}<div className="page page--settings">
    <header className="page-header">
      <div className="page-header__title"><span className="page-icon"><Icon name="settings" size={21} /></span><div><p className="eyebrow">Workspace</p><h1>Settings</h1><p>Keep local preferences and connection boundaries visible.</p></div></div>
      <ApiStatusPill status={apiStatus} />
    </header>
    <div className="settings-grid">
      <section className="settings-card">
        <div className="settings-card__header"><div><h2>API connection</h2><p>The web client only calls the URL configured here. No backend data is bundled in the shell.</p></div><Icon name="external" size={19} /></div>
        <form onSubmit={save} className="settings-form"><label>API base URL<input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setSaved(false) }} placeholder="/api/v1" inputMode="url" /></label><p className="field-help">Default: <code>/api/v1</code>. Use <code>VITE_API_BASE_URL</code> for a build-time value.</p><button className="button button--primary" type="submit"><Icon name="refresh" size={16} />Save connection</button>{saved && <span className="save-note" role="status">Saved locally. Reload to check the new endpoint.</span>}</form>
      </section>
      <section className="settings-card">
        <div className="settings-card__header"><div><h2>Owner session</h2><p>One owner session is shared by every module and restored automatically when you reopen Aelys.</p></div><Icon name="lock" size={19} /></div>
        <div className="settings-form"><p className="save-note" role="status">Сессия активна на этом устройстве.</p><button className="button button--quiet" type="button" disabled={authBusy} onClick={() => void signOut()}>{authBusy ? 'Выходим…' : 'Sign out'}</button>{authMessage && <span role="status">{authMessage}</span>}</div>
      </section>
      <section className="settings-card">
        <div className="settings-card__header"><div><h2>Appearance</h2><p>Theme preference is stored in this browser.</p></div><Icon name={theme === 'dark' ? 'moon' : 'sun'} size={19} /></div>
        <button className="theme-toggle" onClick={onToggleTheme}><span className={`theme-option ${theme === 'light' ? 'theme-option--selected' : ''}`}><Icon name="sun" size={16} />Light</span><span className={`theme-option ${theme === 'dark' ? 'theme-option--selected' : ''}`}><Icon name="moon" size={16} />Dark</span></button>
      </section>
      <section className="settings-card settings-card--wide">
        <div className="settings-card__header"><div><h2>Privacy boundary</h2><p>Web UI status for local-only data.</p></div><Icon name="cloud-off" size={19} /></div>
        <div className="privacy-list"><div><span className="privacy-dot privacy-dot--green" />Full CLI transcripts and embeddings remain on Mac.</div><div><span className="privacy-dot privacy-dot--blue" />Automation actions stay behind the Policy Engine.</div><div><span className="privacy-dot privacy-dot--purple" />BYOK secrets are never rendered in this client.</div></div>
      </section>
    </div>
  </div></>
}
