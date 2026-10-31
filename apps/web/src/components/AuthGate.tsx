import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '@aelys/shared'
import { bootstrapOwner, browserAuthStatus, clearNativeSignedOut, getAccessToken, getApiConfig, getSharedApiClient, isSignedOut, login, resumeBrowserSession, saveApiBaseUrl, SESSION_EVENT } from '../lib/api'
import type { ApiStatus } from '../types'
import './auth-entry.css'
import { Icon } from './Icon'
import { isKeychainAccessRequired, isNativeHost, KEYCHAIN_ACCESS_NOTICE, loadNativeTransport, nativeBackendOrigin, NATIVE_SESSION_EXPIRED_EVENT } from '../lib/nativeTransport'
import { navigate } from '../lib/router'
import { KeychainAccessRecovery } from './KeychainAccessRecovery'
import { LaunchIntro } from './LaunchIntro'
import { TouchIdIcon } from './TouchIdIcon'

type AuthState = 'checking' | 'ready' | 'login' | 'setup' | 'connection' | 'biometric'

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
  const generation = useRef(0)
  const explicitReauthentication = useRef(false)
  const nativeHost = isNativeHost()
  const androidHost = nativeHost && /Android/i.test(navigator.userAgent)
  useEffect(() => {
    const update = () => { generation.current += 1; setPassword(''); setNotice(''); if (isNativeHost()) { setState('checking'); setRetry((value) => value + 1) } else setState(getAccessToken() ? 'ready' : 'login') }
    const storage = (event: StorageEvent) => { if (event.key === 'aelys.signedOut') update() }
    const expired = (event: Event) => {
      if ((event as CustomEvent<{ origin: string }>).detail?.origin !== nativeBackendOrigin(getApiConfig().baseUrl)) return
      explicitReauthentication.current = true
      generation.current += 1; setPassword(''); setNotice('Сессия завершена. Подтвердите вход ещё раз.'); setState('login'); setRetry((value) => value + 1)
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
          if (isSignedOut()) { setCanUnlock(false); publish('login'); return }
          if (alive && generation.current === run) setCanUnlock(!androidHost && !!native.biometric_locked && !!native.can_resume)
          if (native.signed_in) { publish('ready'); return }
          if (native.biometric_locked && native.can_resume) { publish(androidHost ? 'login' : 'biometric'); return }
          if (!native.initialized) { publish('setup'); return }
          if (explicitReauthentication.current) { publish('login', 'Сессия завершена. Войдите ещё раз.'); return }
          if (native.can_resume) {
            try { await transport.resume(origin); publish('ready'); return }
            catch (error) {
              if (isKeychainAccessRequired(error)) { publish('login', KEYCHAIN_ACCESS_NOTICE); return }
              /* Request sign-in after an unsuccessful resume. */
            }
          }
          publish('login'); return
        }
        if (getAccessToken()) { await getSharedApiClient().me(); publish('ready'); return }
        const status = await browserAuthStatus()
        if (!status.initialized) { publish('setup'); return }
        if (status.can_resume && !isSignedOut() && await resumeBrowserSession()) { publish('ready'); return }
        publish('login')
      } catch (error) {
        if (isKeychainAccessRequired(error)) publish('login', KEYCHAIN_ACCESS_NOTICE)
        else if (error instanceof ApiError && error.status === 401) publish('login')
        else publish('connection', 'Не удалось подключиться к серверу. Проверьте соединение и повторите.')
      }
    }
    void check()
    return () => { alive = false }
  }, [apiStatus, retry])
  const unlock = async () => {
    if (busy) return
    const run = generation.current
    const origin = nativeBackendOrigin(getApiConfig().baseUrl)
    setBusy(true); setNotice('')
    try {
      const transport = await loadNativeTransport()
      const result = await transport.resume(origin)
      if (!result.signed_in) throw new Error('Resume failed')
      if (run === generation.current && origin === nativeBackendOrigin(getApiConfig().baseUrl)) { explicitReauthentication.current = false; setState('ready') }
    } catch (error) {
      if (run === generation.current) setNotice(isKeychainAccessRequired(error) ? KEYCHAIN_ACCESS_NOTICE : 'Не удалось открыть с Touch ID. Попробуйте ещё раз или войдите с паролем.')
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
        setCanUnlock(false); setState('login'); setNotice('Сохранённая сессия не найдена. Войдите с паролем.')
        return
      }
      const status = await transport.status(origin)
      if (run !== generation.current || origin !== nativeBackendOrigin(getApiConfig().baseUrl)) return
      if (!androidHost && status.can_resume && status.biometric_locked) {
        setCanUnlock(true); setState('biometric'); setNotice('')
      } else {
        setCanUnlock(false); setState('login'); setNotice('Войдите с паролем Aelys.')
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
        clearNativeSignedOut()
      } else if (state === 'setup') await bootstrapOwner(email.trim(), password)
      else await login(email.trim(), password)
      if (run === generation.current && base === getApiConfig().baseUrl) { explicitReauthentication.current = false; setPassword(''); setState('ready') }
    } catch (error) {
      if (run === generation.current) {
        if (error instanceof ApiError && error.code === 'ALREADY_INITIALIZED') setState('login')
        setNotice(isKeychainAccessRequired(error) ? KEYCHAIN_ACCESS_NOTICE : error instanceof ApiError ? error.message : 'Не удалось войти. Проверьте соединение и повторите.')
      }
    } finally { setBusy(false) }
  }
  const keychainDenied = notice === KEYCHAIN_ACCESS_NOTICE
  const panel = <div className="auth-entry">
      <section className="auth-panel" aria-label="Вход в Aelys" aria-busy={busy}>
        {state === 'biometric' ? <button type="button" className={`auth-emblem${busy ? ' auth-emblem--pending' : ''}`} aria-label="Открыть с Touch ID" disabled={busy} onClick={() => void unlock()}><TouchIdIcon pending={busy} /></button> : <div className={`auth-emblem${state === 'checking' || busy ? ' auth-emblem--pending' : ''}`} aria-hidden="true"><Icon name={state === 'connection' ? 'cloud-off' : 'lock'} size={36} strokeWidth={1.5} /></div>}
        {state === 'checking' ? <>
          <h1>Открываем Aelys…</h1><p className="auth-description" role="status">Проверяем сессию.</p>
        </> : state === 'connection' ? <>
          <h1>Сервер недоступен</h1>
          <p className="auth-description">{androidHost ? 'Укажите HTTPS-адрес сервера на Mac. Адрес 127.0.0.1 ведёт на сам телефон.' : 'Проверьте, запущен ли сервер Aelys.'}</p>
          <button type="button" className="auth-submit" onClick={() => { window.dispatchEvent(new Event('aelys:check-api')); setRetry((value) => value + 1) }}>Повторить подключение</button>
        </> : state === 'biometric' ? <>
          <h1>Открыть Aelys</h1>
          <p className="auth-description">Подтвердите вход с Touch ID.</p>
          <div className="auth-actions">
            <button type="button" className={`auth-submit${keychainDenied ? ' auth-submit--secondary' : ''}`} disabled={busy} onClick={() => void unlock()}>{busy ? 'Открываем…' : 'Открыть с Touch ID'}</button>
            <button type="button" className="auth-text-action" disabled={busy} onClick={() => { setNotice(''); setState('login') }}>Войти с паролем</button>
          </div>
        </> : <>
          <h1>{state === 'setup' ? 'Создать аккаунт' : 'Войти в Aelys'}</h1>
          <p className="auth-description">{state === 'setup' ? 'Один аккаунт для ваших устройств.' : 'Введите email и пароль аккаунта.'}</p>
          <form className="auth-form" onSubmit={authenticate}>
            <label htmlFor="aelys-entry-email">Email<input id="aelys-entry-email" autoFocus required disabled={busy} type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label htmlFor="aelys-entry-password">Пароль<input id="aelys-entry-password" required disabled={busy} type="password" minLength={8} autoComplete={state === 'setup' ? 'new-password' : 'current-password'} placeholder={state === 'setup' ? 'Не менее 8 символов' : 'Пароль аккаунта'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button type="submit" className={`auth-submit${keychainDenied ? ' auth-submit--secondary' : ''}`} disabled={busy}>{busy ? 'Открываем…' : state === 'setup' ? 'Создать аккаунт' : 'Войти'}</button>
          </form>
          {nativeHost && canUnlock && state === 'login' && <button type="button" className="auth-text-action auth-return" disabled={busy} onClick={() => { setNotice(''); setPassword(''); setState('biometric') }}>Вернуться к Touch ID</button>}
        </>}
        {notice && <div className="auth-notice" role="alert">
          <Icon name="alert" size={17} />
          <div><p>{notice}</p>{keychainDenied && <KeychainAccessRecovery pending={busy} onAuthorize={() => void authorizeKeychain()} />}</div>
        </div>}
      </section>
    </div>
  const footer = <div className="auth-entry auth-entry--foot">
    <footer className="auth-footer">
      {connectionOpen && <form className="auth-server-form auth-form" aria-label="Подключение к серверу" onSubmit={(event) => { event.preventDefault(); if (busy) return; saveApiBaseUrl(baseUrl); setConnectionOpen(false); setState('checking'); setRetry((value) => value + 1) }}>
        <div className="auth-server-heading"><h2>Сервер Aelys</h2><button type="button" className="auth-close" aria-label="Закрыть настройки сервера" disabled={busy} onClick={() => setConnectionOpen(false)}><Icon name="x" size={18} /></button></div>
        <label htmlFor="aelys-entry-server">Адрес<input id="aelys-entry-server" required disabled={busy} inputMode="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        {androidHost && <p className="auth-field-help">Android принимает только HTTPS. Например: https://your-host.example/api/v1</p>}
        <button type="submit" disabled={busy} className="auth-submit">Подключиться</button>
      </form>}
      <a href="/components" aria-disabled={busy} onClick={(event) => { event.preventDefault(); if (!busy) navigate('/components') }}>Компоненты</a>
      {state !== 'checking' && <button type="button" disabled={busy} aria-expanded={connectionOpen} onClick={() => setConnectionOpen((value) => !value)}><Icon name="sliders" size={14} />Адрес сервера</button>}
    </footer>
  </div>
  // One persistent scene: it plays the introduction, then either docks into the entry card or fades out when signed in.
  return <>{state === 'ready' && children}<LaunchIntro resolved={state !== 'checking'} locked={state !== 'ready'} footer={footer}>{panel}</LaunchIntro></>
}
