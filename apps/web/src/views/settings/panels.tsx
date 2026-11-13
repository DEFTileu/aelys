import { useEffect, useState, type FormEvent } from 'react'
import type { TelegramSettingsPatch, TelegramStatus } from '@aelys/shared'
import { AelysMark } from '../../components/AelysMark'
import { BiometricSettings } from '../../components/BiometricSettings'
import { getApiConfig, getSharedApiClient, logout, saveApiBaseUrl } from '../../lib/api'
import { greetingForHour } from '../../lib/format'
import { isKeychainAccessRequired, isNativeHost, KEYCHAIN_ACCESS_NOTICE } from '../../lib/nativeTransport'
import { displayNameFromEmail, type Owner } from '../../lib/owner'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { notifyPermission, requestNotifyPermission, sendSystemNotification, type NotifyPermission } from '../../lib/systemNotifications'
import type { ApiStatus } from '../../types'
import pkg from '../../../package.json'
import { Lock } from '../../icons'
import { Card, Group, Row, Segmented, SelectChip, SwitchRow } from './ui'
import { AndroidUpdatesPanel } from './AndroidUpdatesPanel'

export function ProfilePanel({ owner }: { owner: Owner }) {
  const { name, greeting } = usePrefs()
  const shown = owner.name ?? 'You'
  const hello = greeting === 'hello' ? 'Hello' : greetingForHour(new Date().getHours())
  return <>
    <div className="st-card st-profile">
      <span className="st-avatar" aria-hidden="true" />
      <div className="st-grow"><div className="st-who-name">{shown}</div><div className="st-who-mail">{owner.email ?? 'Owner'}</div></div>
    </div>
    <Card>
      <div className="st-pad"><div className="st-label">Name</div><input className="st-input" aria-label="Name" maxLength={60} value={name} placeholder={displayNameFromEmail(owner.email) ?? 'Your name'} onChange={(event) => setPrefs({ name: event.target.value })} /></div>
      <Row title="Greeting" hint={`“${hello}, ${shown}” on Home`}>
        <SelectChip label="Greeting" value={greeting} onChange={(value) => setPrefs({ greeting: value === 'hello' ? 'hello' : 'time' })} options={[['time', 'By time of day'], ['hello', 'Always “Hello”']]} />
      </Row>
    </Card>
  </>
}

// Reminders and quiet hours are real Telegram settings; the bell and in-app alerts have no per-category switches.
function SystemNotificationsCard() {
  const [permission, setPermission] = useState<NotifyPermission | null>(null)
  useEffect(() => { void notifyPermission().then(setPermission) }, [])
  if (permission === null || permission === 'unsupported') return null
  const hint = permission === 'granted' ? 'Reminders and alerts appear as system notifications while Aelys is running.'
    : permission === 'denied' ? 'Notifications are blocked. Allow Aelys in System Settings → Notifications (Android: app settings → Notifications).'
    : 'Allow Aelys to show reminders and alerts as system notifications.'
  return <Group title="This device">
    <Card>
      <Row title="System notifications" hint={hint} wrap>
        {permission === 'prompt' && <button type="button" className="st-btn" onClick={() => void requestNotifyPermission().then(setPermission)}>Allow</button>}
        {permission === 'granted' && <button type="button" className="st-btn" onClick={() => void sendSystemNotification('Aelys', 'Notifications are working.')}>Send test</button>}
      </Row>
    </Card>
  </Group>
}

export function NotificationsPanel({ onGo }: { onGo: (id: 'telegram') => void }) {
  return <><SystemNotificationsCard /><TelegramReminders onGo={onGo} /></>
}

function TelegramReminders({ onGo }: { onGo: (id: 'telegram') => void }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void getSharedApiClient().telegramStatus().then((value) => { if (active) setStatus(value) }).catch(() => { if (active) setNotice('Could not load your reminder settings. Open Connection to check your session.') }).finally(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [])
  const patch = async (change: Omit<TelegramSettingsPatch, 'version'>) => {
    if (busy || status?.version == null) return
    setBusy(true); setNotice('')
    try { setStatus(await getSharedApiClient().updateTelegramSettings({ version: status.version, ...change })) }
    catch { setNotice('Could not save. Refresh the page and try again.') }
    finally { setBusy(false) }
  }
  const quiet = !status?.quiet_start && !status?.quiet_end ? 'off' : status?.quiet_start === '22:00' && status?.quiet_end === '08:00' ? 'night' : 'custom'
  if (!status?.configured) return <>
    <Card>
      <Row title="Telegram reminders" hint={loaded ? 'Connect Telegram to get task reminders there and to choose quiet hours.' : 'Checking Telegram…'} wrap>
        {loaded && <button type="button" className="st-btn" onClick={() => onGo('telegram')}>Open Telegram</button>}
      </Row>
    </Card>
    {notice && <div className="st-note" role="status">{notice}</div>}
  </>
  const ready = !busy && status.version != null
  return <>
    <Group title="Notify me about">
      <Card>
        <SwitchRow title="Deadline reminders" hint="In Telegram, 5 hours and 10 minutes before a task is due" checked={status.deadline_reminders ?? false} disabled={!ready} onChange={(on) => void patch({ deadline_reminders: on })} />
      </Card>
    </Group>
    <div className="st-card st-block">
      <div><div className="st-label">Quiet hours</div><div className="st-hint">Telegram reminders wait until quiet hours end</div></div>
      <Segmented label="Quiet hours" value={quiet} disabled={!ready} onChange={(value) => { if (value === 'off') void patch({ quiet_start: null, quiet_end: null }); else if (value === 'night') void patch({ quiet_start: '22:00', quiet_end: '08:00' }) }}
        options={[['off', 'Off'], ['night', '22:00–08:00'], ...(quiet === 'custom' ? [['custom', `${status.quiet_start}–${status.quiet_end}`] as const] : [])]} />
    </div>
    {notice && <div className="st-note" role="status">{notice}</div>}
  </>
}

export function ConnectionPanel({ apiStatus, owner }: { apiStatus: ApiStatus; owner: Owner }) {
  const [baseUrl, setBaseUrl] = useState(getApiConfig().baseUrl)
  const [saved, setSaved] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const save = (event: FormEvent) => {
    event.preventDefault()
    saveApiBaseUrl(baseUrl)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2200)
  }
  const signOut = async () => {
    if (authBusy) return
    setAuthBusy(true); setAuthMessage('')
    try { await logout(); setAuthMessage('You signed out of Aelys.') }
    catch (error) {
      const code = error instanceof Error ? error.message : error
      setAuthMessage(isKeychainAccessRequired(error) ? KEYCHAIN_ACCESS_NOTICE : code === 'LOCAL_LOGOUT_ONLY' ? 'You signed out on this device. The server did not confirm the session was revoked.' : isNativeHost() ? 'Could not sign out. Try again.' : 'Signed out locally. The server is unavailable.')
    } finally { setAuthBusy(false) }
  }
  const good = apiStatus === 'ready' || apiStatus === 'empty'
  const label = good ? 'Connected' : apiStatus === 'loading' ? 'Checking connection' : apiStatus === 'offline' ? 'Offline' : 'API unavailable'
  return <>
    <div className={`st-banner${good ? '' : ' st-banner--bad'}`} role="status"><span className="st-dot" /><b>{label}</b><span className="st-mono" style={{ fontSize: 13 }}>{getApiConfig().baseUrl}</span></div>
    <form className="st-card st-pad" style={{ padding: '16px 18px' }} onSubmit={save}>
      <div className="st-label">API base URL</div><div className="st-hint" style={{ marginBottom: 10 }}>Default /api/v1</div>
      <div className="st-url">
        <input className="st-input st-input--mono" aria-label="API base URL" value={baseUrl} placeholder="/api/v1" inputMode="url" onChange={(event) => { setBaseUrl(event.target.value); setSaved(false) }} />
        <button type="submit" className={`st-btn st-btn--primary${saved ? ' st-btn--ok' : ''}`}>{saved ? 'Saved' : 'Save'}</button>
      </div>
      {saved && <div className="st-hint" role="status" style={{ marginTop: 10 }}>Saved locally. Reload to check the new endpoint.</div>}
    </form>
    <Group title="Owner session">
      <Card>
        <Row title="Signed in as" tall={false}><span className="st-hint" style={{ fontSize: 'inherit' }}>{owner.email ?? 'Owner'}</span></Row>
        <div className="st-row st-row--end"><button type="button" className="st-btn st-btn--danger" disabled={authBusy} onClick={() => void signOut()}>{authBusy ? 'Signing out…' : 'Sign out'}</button></div>
        {authMessage && <div className="st-msg" role="status">{authMessage}</div>}
      </Card>
    </Group>
  </>
}

export function SecurityPanel() {
  if (isNativeHost()) return <BiometricSettings />
  return <>
    <Card><Row title="Touch ID" hint="Unlocking with Touch ID is available in the Aelys Mac app." /></Card>
    <div className="st-note"><Lock size={14} aria-hidden="true" />Your session is protected by your Aelys password.</div>
  </>
}

export function AboutPanel() {
  return <Card>
    <div className="st-row st-row--14 st-row--wrap"><AelysMark size={36} /><div className="st-grow"><div className="st-label">Aelys {pkg.version}</div><div className="st-hint">Mac, Android and web share one backend</div></div></div>
    <AndroidUpdatesPanel />
  </Card>
}
