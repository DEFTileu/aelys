import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '@aelys/shared'
import { bootstrapOwner, browserAuthStatus, claimSetupToken, clearNativeSignedOut, getAccessToken, getApiConfig, getSharedApiClient, hasDeviceIdentity, isSignedOut, login, resumeBrowserSession, saveApiBaseUrl, SESSION_EVENT, setNativeCacheOwner, signInWithThisDevice, startOutboxReplay } from '../lib/api'
import type { ApiStatus } from '../types'
import './auth-entry.css'
import { Icon } from './Icon'
import { isKeychainAccessRequired, isNativeHost, KEYCHAIN_ACCESS_NOTICE, loadNativeTransport, nativeBackendOrigin, NATIVE_SESSION_EXPIRED_EVENT } from '../lib/nativeTransport'
import { KeychainAccessRecovery } from './KeychainAccessRecovery'
import { LaunchIntro } from './LaunchIntro'
import { TouchIdIcon } from './TouchIdIcon'
import { localBrowserLaunchId } from '../lib/localBrowserLogin'

type AuthState = 'checking' | 'ready' | 'login' | 'setup' | 'connection' | 'biometric'

function defaultDeviceName(): string {
  const platform = typeof navigator === 'undefined' ? '' : (navigator.platform || '').trim()
  return platform ? `Browser (${platform})` : 'Browser'
}

function claimMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : ''
  if (code === 'INVALID_SETUP_TOKEN') return 'The token is invalid, already used or expired. Issue a new one on the server.'
  if (code === 'RATE_LIMITED') return 'Too many attempts. Wait a moment and try again.'
  if (code === 'ALREADY_INITIALIZED') return 'The owner already exists. Sign in or use a recovery token.'
  if (code === 'DEVICE_KEY_UNAVAILABLE' || code === 'INVALID_PUBLIC_KEY') return 'This browser cannot store the device key. Open Aelys over HTTPS or on localhost.'
  return error instanceof ApiError ? error.message : 'Could not connect the device. Check your connection and try again.'
}

export function AuthGate({ apiStatus, children }: { apiStatus: ApiStatus; children: ReactNode }) {
  const [state, setState] = useState<AuthState>('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [canUnlock, setCanUnlock] = useState(false)
  const [retry, setRetry] = useState(0)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState(() => getApiConfig().baseUrl)
  // A fresh server is claimed with a setup token; password creation is offered only while the server still allows it.
  const [tokenMode, setTokenMode] = useState(false)
  const [token, setToken] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [passwordSetup, setPasswordSetup] = useState(true)
  const [deviceKnown, setDeviceKnown] = useState(false)
  const generation = useRef(0)
  const explicitReauthentication = useRef(false)
  const nativeHost = isNativeHost()
  const localLogin = !!localBrowserLaunchId()
  const androidHost = nativeHost && /Android/i.test(navigator.userAgent)
  useEffect(() => {
    const update = () => { generation.current += 1; setPassword(''); setNotice(''); if (isNativeHost()) { setState('checking'); setRetry((value) => value + 1) } else setState(getAccessToken() ? 'ready' : 'login') }
    const storage = (event: StorageEvent) => { if (event.key === 'aelys.signedOut') update() }
    const expired = (event: Event) => {
      if ((event as CustomEvent<{ origin: string }>).detail?.origin !== nativeBackendOrigin(getApiConfig().baseUrl)) return
      explicitReauthentication.current = true
      generation.current += 1; setPassword(''); setNotice('Your session ended. Confirm sign-in again.'); setState('login'); setRetry((value) => value + 1)
    }
    window.addEventListener(SESSION_EVENT, update)
    window.addEventListener('storage', storage)
    window.addEventListener(NATIVE_SESSION_EXPIRED_EVENT, expired)
    return () => { window.removeEventListener(SESSION_EVENT, update); window.removeEventListener('storage', storage); window.removeEventListener(NATIVE_SESSION_EXPIRED_EVENT, expired) }
  }, [])
  useEffect(() => {
    const run = ++generation.current
    let alive = true
    const publish = (value: AuthState, message = '') => { if (alive && generation.current === run) { setState(value); setNotice(message) } }
    const check = async () => {
      if (apiStatus === 'loading') return
      if (apiStatus !== 'ready') { publish(!isNativeHost() && getAccessToken() ? 'ready' : 'connection'); return }
      try {
        if (isNativeHost()) {
          const transport = await loadNativeTransport()
          const origin = nativeBackendOrigin(getApiConfig().baseUrl)
          const native = await transport.status(origin)
          if (native.signed_in) setNativeCacheOwner(native.owner_id)
          if (isSignedOut()) { setCanUnlock(false); publish('login'); return }
          if (alive && generation.current === run) setCanUnlock(!androidHost && !!native.biometric_locked && !!native.can_resume)
          if (native.signed_in) { publish('ready'); return }
          if (native.biometric_locked && native.can_resume) { publish(androidHost ? 'login' : 'biometric'); return }
          if (!native.initialized) { publish('setup'); return }
          if (explicitReauthentication.current) { publish('login', 'Your session ended. Sign in again.'); return }
          if (native.can_resume) {
            try { setNativeCacheOwner((await transport.resume(origin)).owner_id); publish('ready'); return }
            catch (error) {
              if (isKeychainAccessRequired(error)) { publish('login', KEYCHAIN_ACCESS_NOTICE); return }
              /* Request sign-in after an unsuccessful resume. */
            }
          }
          publish('login'); return
        }
        if (getAccessToken()) { await getSharedApiClient().me(); publish('ready'); return }
        const status = await browserAuthStatus()
        if (alive && generation.current === run) setPasswordSetup(status.password_setup !== false)
        if (!status.initialized) { if (alive && generation.current === run) setTokenMode(!localLogin || status.password_setup === false); publish('setup'); return }
        const known = await hasDeviceIdentity()
        if (alive && generation.current === run) setDeviceKnown(known)
        if (known && !isSignedOut() && await resumeBrowserSession()) { publish('ready'); return }
        if (status.can_resume && !isSignedOut() && await resumeBrowserSession()) { publish('ready'); return }
        publish('login')
      } catch (error) {
        if (isKeychainAccessRequired(error)) publish('login', KEYCHAIN_ACCESS_NOTICE)
        else if (error instanceof ApiError && error.status === 401) publish('login')
        else publish('connection', 'Could not reach the server. Check your connection and try again.')
      }
    }
    void check()
    return () => { alive = false }
  }, [apiStatus, retry])
  useEffect(() => (state === 'ready' ? startOutboxReplay() : undefined), [state])
  const unlock = async () => {
    if (busy) return
    const run = generation.current
    const origin = nativeBackendOrigin(getApiConfig().baseUrl)
    setBusy(true); setNotice('')
    try {
      const transport = await loadNativeTransport()
      const result = await transport.resume(origin)
      if (!result.signed_in) throw new Error('Resume failed')
      setNativeCacheOwner(result.owner_id)
      if (run === generation.current && origin === nativeBackendOrigin(getApiConfig().baseUrl)) { explicitReauthentication.current = false; setState('ready') }
    } catch (error) {
      if (run === generation.current) setNotice(isKeychainAccessRequired(error) ? KEYCHAIN_ACCESS_NOTICE : 'Could not unlock with Touch ID. Try again or sign in with your password.')
    } finally { setBusy(false) }
  }
  const authorizeKeychain = async () => {
    if (busy) return
    const run = generation.current
    const origin = nativeBackendOrigin(getApiConfig().baseUrl)
    setBusy(true)
    try {
      const transport = await loadNativeTransport()
      const found = await transport.authorizeKeychain(origin, 'session')
      if (run !== generation.current || origin !== nativeBackendOrigin(getApiConfig().baseUrl)) return
      if (!found) {
        setCanUnlock(false); setState('login'); setNotice('No saved session found. Sign in with your password.')
        return
      }
      const status = await transport.status(origin)
      if (run !== generation.current || origin !== nativeBackendOrigin(getApiConfig().baseUrl)) return
      if (!androidHost && status.can_resume && status.biometric_locked) {
        setCanUnlock(true); setState('biometric'); setNotice('')
      } else {
        setCanUnlock(false); setState('login'); setNotice('Sign in with your Aelys password.')
      }
    } catch {
      if (run === generation.current) setNotice(KEYCHAIN_ACCESS_NOTICE)
    } finally { setBusy(false) }
  }
  const authenticate = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const run = generation.current
    const base = getApiConfig().baseUrl
    setBusy(true); setNotice('')
    try {
      if (isNativeHost()) {
        const transport = await loadNativeTransport()
        const result = await transport.login(nativeBackendOrigin(base), email.trim(), password, state === 'setup')
        if (!result.signed_in) throw new Error('Sign-in failed')
        setNativeCacheOwner(result.owner_id)
        clearNativeSignedOut()
      } else if (state === 'setup') await bootstrapOwner(email.trim(), password)
      else await login(email.trim(), password)
      if (run === generation.current && base === getApiConfig().baseUrl) { explicitReauthentication.current = false; setPassword(''); setState('ready') }
    } catch (error) {
      if (run === generation.current) {
        if (error instanceof ApiError && error.code === 'ALREADY_INITIALIZED') setState('login')
        setNotice(isKeychainAccessRequired(error) ? KEYCHAIN_ACCESS_NOTICE : error instanceof ApiError ? error.message : 'Could not sign in. Check your connection and try again.')
      }
    } finally { setBusy(false) }
  }
  const claim = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const run = generation.current
    const base = getApiConfig().baseUrl
    setBusy(true); setNotice('')
    try {
      await claimSetupToken(token, deviceName)
      if (run === generation.current && base === getApiConfig().baseUrl) { setToken(''); setTokenMode(false); setState('ready') }
    } catch (error) {
      if (run === generation.current) setNotice(claimMessage(error))
    } finally { setBusy(false) }
  }
  const useThisDevice = async () => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      if (await signInWithThisDevice()) setState('ready')
      else setNotice('Could not sign in with this device. It may have been removed from the account: sign in with a password or token.')
    } catch { setNotice('Could not reach the server. Check your connection and try again.') }
    finally { setBusy(false); setDeviceKnown(await hasDeviceIdentity()) }
  }
  const keychainDenied = notice === KEYCHAIN_ACCESS_NOTICE
  const panel = <div className="auth-entry">
      <section className="auth-panel" aria-label="Sign in to Aelys" aria-busy={busy}>
        {state === 'biometric' ? <button type="button" className={`auth-emblem${busy ? ' auth-emblem--pending' : ''}`} aria-label="Unlock with Touch ID" disabled={busy} onClick={() => void unlock()}><TouchIdIcon pending={busy} /></button> : <div className={`auth-emblem${state === 'checking' || busy ? ' auth-emblem--pending' : ''}`} aria-hidden="true"><Icon name={state === 'connection' ? 'cloud-off' : 'lock'} size={36} strokeWidth={1.5} /></div>}
        {state === 'checking' ? <>
          <h1>Opening Aelys…</h1><p className="auth-description" role="status">Checking your session.</p>
        </> : state === 'connection' ? <>
          <h1>Server unavailable</h1>
          <p className="auth-description">{androidHost ? 'Enter the HTTPS address of the server on your Mac. 127.0.0.1 points to the phone itself.' : 'Check that the Aelys server is running.'}</p>
          <button type="button" className="auth-submit" onClick={() => { window.dispatchEvent(new Event('aelys:check-api')); setRetry((value) => value + 1) }}>Retry connection</button>
        </> : state === 'biometric' ? <>
          <h1>Open Aelys</h1>
          <p className="auth-description">Confirm sign-in with Touch ID.</p>
          <div className="auth-actions">
            <button type="button" className={`auth-submit${keychainDenied ? ' auth-submit--secondary' : ''}`} disabled={busy} onClick={() => void unlock()}>{busy ? 'Opening…' : 'Unlock with Touch ID'}</button>
            <button type="button" className="auth-text-action" disabled={busy} onClick={() => { setNotice(''); setState('login') }}>Sign in with password</button>
          </div>
        </> : (state === 'setup' || state === 'login') && tokenMode ? <>
          <h1>Setup token</h1>
          <p className="auth-description">{state === 'setup' ? 'Enter the one-time token the server printed to the console on first start.' : 'A recovery token adds this device to your account.'}</p>
          <form className="auth-form" onSubmit={claim}>
            <label htmlFor="aelys-entry-token">Token<input id="aelys-entry-token" className="auth-token" autoFocus required disabled={busy} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Paste the token" value={token} onChange={(event) => setToken(event.target.value)} /></label>
            <label htmlFor="aelys-entry-device-name">Device name<input id="aelys-entry-device-name" required disabled={busy} maxLength={200} autoComplete="off" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label>
            <button type="submit" className="auth-submit" disabled={busy || token.trim().length < 20}>{busy ? 'Checking…' : 'Connect device'}</button>
          </form>
          <p className="auth-field-help">New token: <code>python -m app.core.admin setup-token</code>{state === 'login' ? ' --recovery' : ''}. It is valid for 30 minutes and works once.</p>
          {(state === 'login' || passwordSetup) && <button type="button" className="auth-text-action" disabled={busy} onClick={() => { setNotice(''); setToken(''); setTokenMode(false) }}>{state === 'login' ? 'Back to sign in' : 'Create account with password'}</button>}
        </> : <>
          <h1>{state === 'setup' ? 'Create account' : 'Sign in to Aelys'}</h1>
          <p className="auth-description">{state === 'setup' ? 'One account for all your devices.' : localLogin ? 'Enter your username and password.' : 'Enter your account email and password.'}</p>
          {state === 'login' && deviceKnown && <button type="button" className="auth-submit" disabled={busy} onClick={() => void useThisDevice()}>{busy ? 'Signing in…' : 'Sign in with this device'}</button>}
          <form className="auth-form" onSubmit={authenticate}>
            <label htmlFor="aelys-entry-email">{localLogin ? 'Username' : 'Email'}<input id="aelys-entry-email" autoFocus required disabled={busy} type={localLogin ? 'text' : 'email'} autoComplete="username" placeholder={localLogin ? 'Username' : 'you@example.com'} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label htmlFor="aelys-entry-password">Password<input id="aelys-entry-password" required disabled={busy} type="password" minLength={localLogin && email === '1' ? 1 : 8} autoComplete={state === 'setup' ? 'new-password' : 'current-password'} placeholder={state === 'setup' && !localLogin ? 'At least 8 characters' : 'Account password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button type="submit" className={`auth-submit${keychainDenied ? ' auth-submit--secondary' : ''}`} disabled={busy}>{busy ? 'Opening…' : state === 'setup' ? 'Create account' : 'Sign in'}</button>
          </form>
          {!nativeHost && (state === 'login' || state === 'setup') && <button type="button" className="auth-text-action" disabled={busy} onClick={() => { setNotice(''); setTokenMode(true) }}>{state === 'login' ? 'Sign in with a setup token' : 'I have a setup token'}</button>}
          {nativeHost && canUnlock && state === 'login' && <button type="button" className="auth-text-action auth-return" disabled={busy} onClick={() => { setNotice(''); setPassword(''); setState('biometric') }}>Back to Touch ID</button>}
        </>}
        {notice && <div className="auth-notice" role="alert">
          <Icon name="alert" size={17} />
          <div><p>{notice}</p>{keychainDenied && <KeychainAccessRecovery pending={busy} onAuthorize={() => void authorizeKeychain()} />}</div>
        </div>}
      </section>
    </div>
  const footer = <div className="auth-entry auth-entry--foot">
    <footer className="auth-footer">
      {connectionOpen && <form className="auth-server-form auth-form" aria-label="Server connection" onSubmit={(event) => { event.preventDefault(); if (busy) return; saveApiBaseUrl(baseUrl); setConnectionOpen(false); setState('checking'); setRetry((value) => value + 1) }}>
        <div className="auth-server-heading"><h2>Aelys server</h2><button type="button" className="auth-close" aria-label="Close server settings" disabled={busy} onClick={() => setConnectionOpen(false)}><Icon name="x" size={18} /></button></div>
        <label htmlFor="aelys-entry-server">Address<input id="aelys-entry-server" required disabled={busy} inputMode="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        {androidHost && <p className="auth-field-help">Android accepts HTTPS only. For example: https://your-host.example/api/v1</p>}
        <button type="submit" disabled={busy} className="auth-submit">Connect</button>
      </form>}
      {state !== 'checking' && <button type="button" disabled={busy} aria-expanded={connectionOpen} onClick={() => setConnectionOpen((value) => !value)}><Icon name="sliders" size={14} />Server address</button>}
    </footer>
  </div>
  // One persistent scene: it plays the introduction, then either docks into the entry card or fades out when signed in.
  return <>{state === 'ready' && children}<LaunchIntro resolved={state !== 'checking'} locked={state !== 'ready'} footer={footer}>{panel}</LaunchIntro></>
}
