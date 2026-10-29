import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { bootstrapOwner, getAccessToken, getApiConfig, login, logout, saveApiBaseUrl } from '../lib/api'
import type { ApiStatus } from '../types'

export function SettingsView({ apiStatus, theme, onToggleTheme }: { apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [baseUrl, setBaseUrl] = useState(getApiConfig().baseUrl)
  const [saved, setSaved] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [firstRun, setFirstRun] = useState(false)

  const save = (event: FormEvent) => {
    event.preventDefault()
    saveApiBaseUrl(baseUrl)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2200)
  }

  const authenticate = async (event: FormEvent) => {
    event.preventDefault()
    setAuthBusy(true)
    setAuthMessage('')
    try {
      if (firstRun) await bootstrapOwner(email, password)
      else await login(email, password)
      setPassword('')
      setAuthMessage(firstRun ? 'Private instance initialized. Your owner session is active.' : 'Signed in for this browser session.')
      window.setTimeout(() => window.location.assign('/tasks'), 250)
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Sign in failed')
    } finally {
      setAuthBusy(false)
    }
  }

  const signOut = async () => {
    await logout()
    setAuthMessage('Owner session revoked')
  }

  return <div className="page page--settings">
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
        <div className="settings-card__header"><div><h2>{firstRun ? 'Initialize private instance' : 'Owner session'}</h2><p>{firstRun ? 'Set the one owner credential for this local Aelys instance.' : 'This is a single-owner Aelys instance. The session is yours; no team accounts or user management are exposed.'}</p></div><Icon name="lock" size={19} /></div>
        {getAccessToken() ? <div className="settings-form"><p className="save-note" role="status">Owner session active for this browser.</p><button className="button button--quiet" type="button" onClick={() => void signOut()}>Sign out</button></div> : <form onSubmit={authenticate} className="settings-form"><label>Owner email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label><label>Owner password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={firstRun ? 'new-password' : 'current-password'} minLength={8} required /></label><button className="button button--primary" type="submit" disabled={authBusy}>{authBusy ? (firstRun ? 'Initializing…' : 'Opening owner session…') : (firstRun ? 'Initialize private instance' : 'Open owner session')}</button>{authMessage && <span className="save-note" role="status">{authMessage}</span>}<button className="text-button" type="button" onClick={() => { setFirstRun((value) => !value); setAuthMessage('') }}>{firstRun ? 'Already initialized? Open owner session' : 'First run? Initialize private instance'}</button></form>}
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
  </div>
}
