import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ApiError } from '@aelys/shared'
import { Check, Lock, Usb } from '../../../icons'
import { getApiConfig } from '../../../lib/api'
import { companion, newPairingSecret, sha256Hex } from '../../../lib/companion/api'
import { CompanionError, CompanionSerial } from '../../../lib/companion/serial'
import { Card } from '../ui'
import './devices.css'

type Stage = 'start' | 'code' | 'wifi' | 'done'
const BLANK = ['', '', '', '', '', '']
const LOST = 'Aelys is in lost mode. Turn lost mode off before pairing it again.'
// Errors after which the board and the backend are asked for a fresh pairing (new secret, new code).
const RESTART = new Set(['PAIRING_EXPIRED', 'TIMEOUT', 'NOT_PENDING'])

const errorCode = (e: unknown) => e instanceof ApiError || e instanceof CompanionError ? e.code : ''
function describe(e: unknown): string {
  const code = errorCode(e)
  if (code === 'LOST_MODE') return LOST
  if (code === 'NOT_AELYS') return 'This USB device is not Aelys. Choose the Aelys port.'
  if (code === 'TIMEOUT') return 'Aelys did not answer. Check the USB cable and try again.'
  if (code === 'BAD_ARGS') return 'Aelys could not accept that. Check the values and try again.'
  return 'Something went wrong. Check the connection and try again.'
}

export function AddCompanion() {
  const [stage, setStage] = useState<Stage>('start')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState(false)
  const [digits, setDigits] = useState(BLANK)
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [online, setOnline] = useState('')
  const serial = useRef<CompanionSerial | null>(null)
  const secret = useRef('') // lives only here; never logged, dropped on unmount
  const pairingId = useRef('')
  const boxes = useRef<(HTMLInputElement | null)[]>([])

  const drop = async () => { const s = serial.current; serial.current = null; secret.current = ''; await s?.close().catch(() => undefined) }
  useEffect(() => () => { void drop() }, [])

  const apiUrl = new URL(getApiConfig().baseUrl, window.location.origin)
  if (!CompanionSerial.supported()) return <div className="st-note"><Usb size={16} aria-hidden="true" /><span>To add a companion, connect it by USB to Aelys on your Mac or on the web. You'll confirm a 6-digit code shown on the device.</span></div>
  if (apiUrl.protocol !== 'https:') return <div className="st-note" role="alert">Aelys needs a secure (https) backend</div>

  // Steps 1-2 silently: the board makes a key, the backend opens a pairing, the board shows the code.
  const begin = async () => {
    const s = serial.current!
    secret.current = newPairingSecret()
    const publicKey = await s.pairBegin(secret.current, apiUrl.href)
    const { pairing_id } = await companion.requestPairing(await sha256Hex(secret.current), publicKey)
    await s.pairCode(pairing_id)
    pairingId.current = pairing_id
    setDigits(BLANK); setStage('code')
  }
  const fail = async (e: unknown, reset: boolean) => {
    if (!(e instanceof Error && e.name === 'NotFoundError')) setError(describe(e)) // the user closing the port chooser is not an error
    if (reset) { await drop(); setFound(false) }
    setStage(reset ? 'start' : 'code'); setBusy(false)
  }

  const connect = async () => {
    setError(''); setBusy(true)
    try {
      serial.current = await CompanionSerial.request()
      await serial.current.info()
      setFound(true)
      await begin(); setBusy(false)
    } catch (e) { await fail(e, true) }
  }

  const restart = async (message: string) => {
    setError(message)
    try { await begin(); setBusy(false) } catch (e) { await fail(e, true) }
  }

  const pair = async () => {
    setError(''); setBusy(true)
    try {
      const { device_id } = await companion.approve(pairingId.current, secret.current, digits.join(''))
      await serial.current!.pairCommit(device_id.toLowerCase()) // the board only takes lowercase UUIDs
    } catch (e) {
      const code = errorCode(e)
      if (code === 'SAS_MISMATCH') return restart("The code doesn't match. Check the digits on Aelys and try again.")
      if (RESTART.has(code)) return restart('The code expired. Aelys is showing a new one.')
      return fail(e, code === 'LOST_MODE')
    }
    secret.current = ''
    const state = await serial.current!.state().catch(() => 'authorized')
    if (state === 'provisioned') await finish('Aelys is already online')
    else { setStage('wifi'); setBusy(false) }
  }

  const finish = async (message: string) => { await drop(); setPassword(''); setOnline(message); setStage('done'); setBusy(false) }
  const send = async () => {
    setError(''); setBusy(true)
    try {
      if (await serial.current!.sendWifi(ssid, password) === 'ok') return await finish(`Aelys is online on ${ssid}`)
      setError(`Wrong password for ${ssid}`); setBusy(false)
    } catch (e) { setError(describe(e)); setBusy(false) }
  }

  const setDigit = (i: number, value: string) => {
    const next = [...digits]; next[i] = value.replace(/\D/g, '').slice(-1); setDigits(next)
    if (next[i] && i < 5) boxes.current[i + 1]?.focus()
  }
  const onKey = (i: number, e: KeyboardEvent) => { if (e.key === 'Backspace' && !digits[i] && i > 0) boxes.current[i - 1]?.focus() }
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!text) return
    e.preventDefault(); setDigits(BLANK.map((_, i) => text[i] ?? ''))
  }

  const badge = (n: number, state: 'done' | 'active' | 'todo') => <span className="dv-badge" data-state={state}>{state === 'done' ? <Check size={14} aria-hidden="true" /> : n}</span>
  const ready = digits.every(Boolean)

  return <>
    <Card>
      <div className="dv-step">
        {badge(1, found ? 'done' : 'active')}
        <div className="dv-body">
          <div><div className="st-label">Connect Aelys by USB-C</div><div className="st-hint">Use a data cable. Chrome or the Aelys app for Mac</div></div>
          {found ? <div className="dv-found"><span className="st-dot" />Aelys found on USB</div>
            : <div className="dv-actions"><button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void connect()}>Connect Aelys</button></div>}
        </div>
      </div>
      <div className="dv-step">
        {badge(2, stage === 'wifi' || stage === 'done' ? 'done' : found ? 'active' : 'todo')}
        <div className="dv-body">
          <div><div className="st-label">Enter the code shown on Aelys</div><div className="st-hint">Make sure it matches the 6 digits on the round screen</div></div>
          {stage === 'code' && <>
            <div className="dv-digits" onPaste={onPaste}>
              {digits.map((d, i) => <input key={i} ref={(el) => { boxes.current[i] = el }} className="dv-digit" inputMode="numeric" autoComplete="one-time-code" aria-label={`Digit ${i + 1}`} value={d} disabled={busy} onChange={(e) => setDigit(i, e.target.value)} onKeyDown={(e) => onKey(i, e)} />)}
            </div>
            <div className="dv-actions"><button type="button" className="st-btn st-btn--primary" disabled={busy || !ready} onClick={() => void pair()}>Pair</button></div>
          </>}
        </div>
      </div>
      <div className="dv-step">
        {badge(3, stage === 'done' ? 'done' : stage === 'wifi' ? 'active' : 'todo')}
        <div className="dv-body">
          <div><div className="st-label">Choose Wi-Fi</div><div className="st-hint">Aelys copies a saved network from this computer, or you add one</div></div>
          {stage === 'done' && <div className="dv-found"><span className="st-dot" />{online}</div>}
          {stage === 'wifi' && <form className="st-form st-form--flush" onSubmit={(e) => { e.preventDefault(); if (ssid && !busy) void send() }}>
            <label className="st-field-label">Network name<input className="st-input" aria-label="Network name" value={ssid} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} onChange={(e) => setSsid(e.target.value)} /></label>
            <label className="st-field-label">Password<input className="st-input" type="password" aria-label="Password" value={password} maxLength={63} autoComplete="off" disabled={busy} onChange={(e) => setPassword(e.target.value)} /></label>
            <div className="dv-actions"><button type="submit" className="st-btn st-btn--primary" disabled={busy || !ssid}>Send to Aelys</button></div>
          </form>}
        </div>
      </div>
    </Card>
    {error && <div className="st-error" role="alert">{error}</div>}
    <div className="st-note"><Lock size={16} aria-hidden="true" /><span>Pairing works only over USB, so nobody can pair Aelys from afar.</span></div>
  </>
}
