import { useRef, useState } from 'react'
import { Info, Lock, MapPin, Mail, Send, Smartphone, Volume2, Wifi } from '../../../icons'
import { companion, reauth } from '../../../lib/companion/api'
import { isNativeHost } from '../../../lib/nativeTransport'
import type { CompanionState, LostMode } from '../../../lib/companion/types'
import { Card, SelectChip } from '../ui'
import { hhmm, type FindControl } from './CompanionOverview'
import { ReauthSheet } from './ReauthSheet'
import { clampBytes } from './bytes'
import { RoundPreview } from './RoundPreview'

const MAX_MESSAGE = 64 // UTF-8 bytes, the board's limit; the design's hint still says 60 characters
type Qr = NonNullable<LostMode['qr']>
const QR_OPTIONS = [['telegram', 'Telegram'], ['phone', 'Phone'], ['none', 'None']] as const
const FAILED = 'Something went wrong. Check the connection and try again.'

interface Props { state: CompanionState; owner: { name: string | null; email: string | null } | undefined; find: FindControl; refresh: () => Promise<void> }

export function LostModePage(props: Props) {
  return props.state.lost_mode?.on ? <LostOn {...props} /> : <LostSetup {...props} />
}

/** A QR whose contact is hidden would open nothing: app, preview and payload all say "none" then. */
const qrFor = (qr: Qr, phoneShown: boolean, telegramShown: boolean): Qr => (qr === 'phone' && !phoneShown) || (qr === 'telegram' && !telegramShown) ? 'none' : qr

function LostSetup({ state, owner, refresh }: Props) {
  const phone = state.contacts?.phone, telegram = state.contacts?.telegram, email = owner?.email ?? undefined
  const [message, setMessage] = useState('')
  // Only what the owner touched is kept; the rest follows the contacts, which may arrive in a later poll.
  const [touched, setTouched] = useState<{ phone?: boolean; telegram?: boolean; email?: boolean; qr?: Qr }>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const showPhone = !!phone && (touched.phone ?? true)
  const showTelegram = !!telegram && (touched.telegram ?? true)
  const showEmail = !!email && (touched.email ?? false)
  const qr = qrFor(touched.qr ?? (telegram ? 'telegram' : phone ? 'phone' : 'none'), showPhone, showTelegram)

  const turnOn = async () => {
    setBusy(true); setError('')
    try {
      await companion.setLost(state.device_id, { on: true, message, show_phone: showPhone, show_telegram: showTelegram, show_email: showEmail, email: showEmail && email ? email : null, qr })
      await refresh()
    } catch { setError(FAILED) }
    setBusy(false)
  }
  const pick = (label: string, Icon: typeof Mail, value: string | undefined, checked: boolean, key: 'phone' | 'telegram' | 'email') =>
    <label className="st-row st-row--14 dv-pick"><input type="checkbox" aria-label={label} checked={checked} disabled={!value || busy} onChange={(e) => setTouched({ ...touched, [key]: e.target.checked })} /><Icon size={18} aria-hidden="true" /><span className="st-grow"><span className="st-label">{label}</span><span className="st-hint">{value ?? 'Not set'}</span></span></label>

  return <>
    <div className="st-sub">Show your contacts on Aelys if it gets lost</div>
    <Card><div className="dv-preview">
      <RoundPreview size={176} name={owner?.name} phone={showPhone ? phone : undefined} telegram={showTelegram ? telegram : undefined} email={showEmail ? email : undefined} message={message} qr={qr} />
      <div className="st-hint">Live preview · what a finder sees</div>
    </div></Card>
    <Card><div className="st-block">
      <label className="st-label" htmlFor="dv-lost-message">Message</label>
      <div className="st-hint">Optional, up to 60 characters</div>
      <input id="dv-lost-message" className="st-input" aria-label="Message" maxLength={MAX_MESSAGE} value={message} disabled={busy} onChange={(e) => setMessage(clampBytes(e.target.value, MAX_MESSAGE))} />
    </div></Card>
    <div className="st-group">
      <div className="st-group-title">Show on Aelys</div>
      <Card>
        {pick('Phone', Smartphone, phone, showPhone, 'phone')}
        {pick('Telegram', Send, telegram, showTelegram, 'telegram')}
        {pick('Email', Mail, email, showEmail, 'email')}
        <div className="st-row st-row--14"><span className="st-grow st-label">QR code opens</span><SelectChip label="QR code opens" value={qr} options={QR_OPTIONS} disabled={busy} onChange={(v) => setTouched({ ...touched, qr: v as Qr })} /></div>
      </Card>
    </div>
    {error && <div className="st-error" role="alert">{error}</div>}
    <button type="button" className="st-btn st-btn--primary dv-wide" disabled={busy} onClick={() => void turnOn()}><MapPin size={16} aria-hidden="true" />Turn on lost mode</button>
  </>
}

function LostOn({ state, owner, find, refresh }: Props) {
  const lost = state.lost_mode!
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef(0) // a cancelled or superseded attempt must not send anything when its fingerprint check returns late
  const since = hhmm(lost.since), seen = hhmm(state.last_seen_at), current = state.wifi?.current

  const turnOff = async () => {
    const mine = ++attempt.current
    setError(''); setSheet(true)
    try {
      const proof = await reauth('lost_off', state.device_id)
      if (mine !== attempt.current) return
      const { since: _since, on: _on, ...rest } = lost
      await companion.setLost(state.device_id, { ...rest, on: false, reauth: proof })
      if (mine !== attempt.current) return
      setSheet(false); await refresh()
    } catch {
      if (mine === attempt.current) setError(FAILED)
    }
  }
  const cancel = () => { attempt.current++; setSheet(false); setError('') }

  return <>
    <div className="dv-lostbar"><MapPin size={18} aria-hidden="true" /><b>Lost mode is on</b>{since && <span>since {since}</span>}</div>
    <Card>
      <div className="st-row"><span className="dv-it dv-it--blue"><Wifi size={18} aria-hidden="true" /></span><div className="st-grow"><div className="st-label">Last seen {seen ?? '—'}</div>{current && <div className="st-hint">On Wi-Fi “{current}”</div>}</div></div>
      <div className="st-row st-row--56"><div className="st-note"><Info size={16} aria-hidden="true" /><span>Aelys has no GPS. Aelys shows the last Wi-Fi network it used.</span></div></div>
    </Card>
    <Card><div className="st-block">
      <div><div className="st-label">Play sound</div><div className="st-hint">Aelys beeps and flashes for 1 minute</div></div>
      <button type="button" className="st-btn st-btn--primary dv-wide" disabled={find.busy} onClick={find.run}><Volume2 size={16} aria-hidden="true" />Play sound</button>
      {find.error && <div className="st-error" role="alert">{find.error}</div>}
    </div></Card>
    <Card><div className="dv-preview dv-preview--row">
      <RoundPreview size={104} name={owner?.name} phone={lost.show_phone ? state.contacts?.phone : undefined} telegram={lost.show_telegram ? state.contacts?.telegram : undefined} email={lost.show_email ? lost.email ?? undefined : undefined} message={lost.message} qr={qrFor(lost.qr ?? 'none', !!lost.show_phone && !!state.contacts?.phone, !!lost.show_telegram && !!state.contacts?.telegram)} />
      <div className="st-hint">Aelys shows your message, phone and Telegram. Its buttons can't turn lost mode off.</div>
    </div></Card>
    <button type="button" className="st-btn st-btn--ghost dv-wide" onClick={() => void turnOff()}><Lock size={16} aria-hidden="true" />Turn off lost mode</button>
    {isNativeHost() && <div className="st-note dv-center">Requires your fingerprint</div>}
    {sheet && <ReauthSheet error={error} onCancel={cancel} />}
  </>
}
