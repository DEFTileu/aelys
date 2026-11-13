import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@aelys/shared'
import { Check, ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Lock, Plus, RefreshCw, Trash2, Wifi, X } from '../../../icons'
import { companion, encryptWifi } from '../../../lib/companion/api'
import type { CompanionCommandLogEntry, CompanionState, WifiScanNetwork } from '../../../lib/companion/types'
import { Card, Group } from '../ui'
import { byteLength, clampBytes } from './bytes'

const FAILED = 'Something went wrong. Check the connection and try again.'
const POLL_MS = 2000
const WAIT_MS = 60_000
const SCAN_WAIT_MS = 20_000
const MAX_SSID = 32, MAX_PASSWORD = 64 // bytes
const MAX_NETWORKS = 5 // the board's list; one more would push the oldest out
const IN_USE = 'Aelys is using this network. Switch first.'
const errorText = (e: unknown) => (e instanceof ApiError && e.code === 'DEVICE_OFFLINE' ? 'Aelys is offline' : FAILED)

/** Polls the command log every 2 s until the board answered the command (null: no answer in time, or the page was left). */
async function waitForCommand(deviceId: string, commandId: string, live: () => boolean, maxMs = WAIT_MS): Promise<CompanionCommandLogEntry | null> {
  for (let waited = 0; waited < maxMs; waited += POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    if (!live()) return null
    try {
      const found = (await companion.state(deviceId)).command_log?.find((c) => c.id === commandId)
      if (found && found.ok !== null) return found
    } catch { /* offline for a moment: keep waiting */ }
  }
  return null
}

const move = (list: string[], from: number, to: number) => { const next = [...list]; next.splice(to, 0, next.splice(from, 1)[0]!); return next }

type Job =
  | { ssid: string; stage: 'sending' | 'connecting' | 'connected' }
  | { ssid: string; stage: 'failed'; kind: 'wrong' | 'offline' | 'failed' }

interface Props { state: CompanionState; refresh: () => Promise<void> }

export function WifiPage({ state, refresh }: Props) {
  const id = state.device_id
  const server = state.wifi?.saved ?? []
  const serverKey = JSON.stringify(server)
  // What the owner just did shows at once; it gives way as soon as the server's own list changes.
  const [override, setOverride] = useState<{ base: string; list: string[] } | null>(null)
  const saved = override && override.base === serverKey ? override.list : server
  const current = state.wifi?.current
  const [sheet, setSheet] = useState<{ ssid: string } | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const listEl = useRef<HTMLDivElement>(null)
  const latest = useRef(saved); latest.current = saved
  const drag = useRef<{ ssid: string; start: string[] } | null>(null)
  const show = (list: string[]) => { latest.current = list; setOverride({ base: serverKey, list }) }

  const sendOrder = async (next: string[], prev: string[]) => {
    setError('')
    try { await companion.orderWifi(id, next) } catch (e) { if (alive.current) { show(prev); setError(errorText(e)) } }
  }
  const remove = async (ssid: string) => {
    const prev = latest.current
    show(prev.filter((s) => s !== ssid)); setError('')
    try {
      const { command_id } = await companion.removeWifi(id, ssid)
      const result = await waitForCommand(id, command_id, () => alive.current)
      if (!alive.current || !result) return
      if (result.ok) await refresh()
      else { show(prev); setError(result.error_code === 'IN_USE' ? IN_USE : FAILED) } // the board refuses its connected or last network
    } catch (e) { if (alive.current) { show(prev); setError(errorText(e)) } }
  }
  const step = (i: number, by: -1 | 1) => { const prev = saved; const next = move(prev, i, i + by); show(next); void sendOrder(next, prev) }

  // The drag listens on window: the row (and its grip) is moved in the DOM by every swap, which makes browsers drop pointer capture.
  const dragMove = useRef<(e: PointerEvent) => void>(() => {})
  const dragEnd = useRef<() => void>(() => {})
  const stopDrag = useRef<(() => void) | null>(null)
  dragMove.current = (e) => {
    const d = drag.current
    const rows = listEl.current?.querySelectorAll('[data-testid="wifi-row"]')
    if (!d || !rows?.length) return
    const from = latest.current.indexOf(d.ssid)
    let to = [...rows].findIndex((row) => e.clientY < row.getBoundingClientRect().bottom)
    if (to < 0) to = rows.length - 1
    if (from >= 0 && to !== from) show(move(latest.current, from, to))
  }
  dragEnd.current = () => {
    const d = drag.current; drag.current = null
    if (d && latest.current.join('\n') !== d.start.join('\n')) void sendOrder(latest.current, d.start)
  }
  const onDown = (ssid: string) => {
    stopDrag.current?.()
    drag.current = { ssid, start: latest.current }
    const onMove = (e: PointerEvent) => dragMove.current(e)
    const stop = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); stopDrag.current = null }
    const onUp = () => { stop(); dragEnd.current() }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
    stopDrag.current = stop
  }
  useEffect(() => () => stopDrag.current?.(), [])

  // The sheet hands over the encryption already under way: the password never reaches this component.
  const send = async (ssid: string, blob: Promise<string>) => {
    setSheet(null); setJob({ ssid, stage: 'sending' }); setError('')
    try {
      const { command_id } = await companion.addWifi(id, await blob)
      if (!alive.current) return
      setJob({ ssid, stage: 'connecting' })
      const result = await waitForCommand(id, command_id, () => alive.current)
      if (!alive.current) return
      if (result?.ok) {
        if (!latest.current.includes(ssid)) show([...latest.current, ssid])
        setJob({ ssid, stage: 'connected' })
        await refresh()
      } else setJob({ ssid, stage: 'failed', kind: result?.error_code === 'WIFI_FAILED' ? 'wrong' : 'failed' })
    } catch (e) {
      if (alive.current) setJob({ ssid, stage: 'failed', kind: e instanceof ApiError && e.code === 'DEVICE_OFFLINE' ? 'offline' : 'failed' })
    }
  }

  const working = job?.stage === 'sending' || job?.stage === 'connecting'
  return <>
    <div className="st-sub">Networks Aelys can join · 2.4 GHz</div>
    {job && job.stage !== 'failed' && <JobCard job={job} />}
    {job?.stage === 'failed' && <div className="dv-fail" role="alert">
      <div className="dv-fail-head">
        <Wifi size={20} aria-hidden="true" />
        <div className="st-grow">
          <div className="dv-fail-title">{job.kind === 'wrong' ? `Wrong password for ${job.ssid}` : `Couldn't add ${job.ssid}`}</div>
          <div className="dv-fail-text">{job.kind === 'wrong' ? (current ? `Aelys is still on ${current}. Nothing else changed` : 'Nothing else changed') : job.kind === 'offline' ? 'Aelys is offline' : FAILED}</div>
        </div>
      </div>
      <div className="dv-actions">
        <button type="button" className="st-btn st-btn--primary dv-grow" onClick={() => { setSheet({ ssid: job.ssid }); setJob(null) }}>Try again</button>
        {job.kind === 'wrong' && !saved.includes(job.ssid) && <button type="button" className="st-btn st-btn--danger" onClick={() => { setConfirm(job.ssid); setJob(null) }}>Remove</button>}
      </div>
    </div>}
    {confirm && <div className="dv-fail" role="alertdialog" aria-label={`Remove ${confirm}?`}>
      <div className="dv-fail-head">
        <Trash2 size={20} aria-hidden="true" />
        <div className="st-grow">
          <div className="dv-fail-title">Remove {confirm}?</div>
          <div className="dv-fail-text">Aelys will forget this network and its password.</div>
        </div>
      </div>
      <div className="dv-actions">
        <button type="button" className="st-btn st-btn--danger dv-grow" onClick={() => { void remove(confirm); setConfirm(null) }}>Remove</button>
        <button type="button" className="st-btn" onClick={() => setConfirm(null)}>Cancel</button>
      </div>
    </div>}
    <Group title="Saved networks">
      <Card>
        <div ref={listEl}>
          {saved.map((ssid, i) => <div key={ssid} className="st-row st-row--14 dv-wifi" data-testid="wifi-row">
            <button type="button" className="dv-grip" aria-label={`Reorder ${ssid}`} aria-hidden="true" tabIndex={-1} onPointerDown={() => onDown(ssid)}><GripVertical size={18} aria-hidden="true" /></button>
            <span className="dv-num" aria-hidden="true">{i + 1}</span>
            <div className="st-grow"><div className="st-label dv-ssid">{ssid}</div><div className={`st-hint${ssid === current ? ' dv-ok' : ''}`}>{ssid === current ? 'Connected' : 'Saved'}</div></div>
            <span className="dv-move">
              <button type="button" aria-label={`Move ${ssid} up`} disabled={i === 0} onClick={() => step(i, -1)}><ChevronUp size={16} aria-hidden="true" /></button>
              <button type="button" aria-label={`Move ${ssid} down`} disabled={i === saved.length - 1} onClick={() => step(i, 1)}><ChevronDown size={16} aria-hidden="true" /></button>
            </span>
            {ssid === current || saved.length < 2 // never the connected or the last network: the board would refuse it
              ? <span className="dv-del" aria-hidden="true"><span style={{ width: 18, height: 18 }} /></span>
              : <button type="button" className="dv-del" aria-label={`Delete ${ssid}`} onClick={() => setConfirm(ssid)}><Trash2 size={18} aria-hidden="true" /></button>}
          </div>)}
        </div>
      </Card>
    </Group>
    {error && <div className="st-error" role="alert">{error}</div>}
    <div className="st-hint dv-pad">Aelys joins the first network in range. Drag to change the order.</div>
    {saved.length < MAX_NETWORKS
      ? <button type="button" className="st-btn st-btn--ghost dv-wide" disabled={working} onClick={() => setSheet({ ssid: '' })}><Plus size={16} aria-hidden="true" />Add network</button>
      : <div className="st-hint dv-pad">Aelys keeps up to {MAX_NETWORKS} networks. Remove one to add another.</div>}
    <div className="st-note"><Lock size={16} aria-hidden="true" /><span>Passwords are encrypted on this phone for Aelys only. Aelys servers never see them.</span></div>
    {sheet && <AddNetworkSheet state={state} refresh={refresh} initialSsid={sheet.ssid} onClose={() => setSheet(null)} onSend={(ssid, blob) => void send(ssid, blob)} />}
  </>
}

function JobCard({ job }: { job: Extract<Job, { stage: 'sending' | 'connecting' | 'connected' }> }) {
  const level = job.stage === 'sending' ? 0 : job.stage === 'connecting' ? 1 : 2
  const status = ['Sending to Aelys…', 'Aelys is connecting…', 'Connected'][level]
  return <Card><div className="dv-job" role="status">
    <div className="st-row">
      <span className="dv-it dv-it--blue"><Wifi size={18} aria-hidden="true" /></span>
      <div className="st-grow"><div className="st-label">{job.ssid}</div><div className={`st-hint${level === 2 ? ' dv-ok' : ''}`}>{status}</div></div>
    </div>
    <div className="dv-steps">
      <div><span className="dv-dot" data-on="true" />Sent from this phone</div>
      <div><span className="dv-dot" data-on={level >= 1} />Aelys received it and is connecting</div>
      <div><span className="dv-dot" data-on={level >= 2} />Connected to {job.ssid}</div>
    </div>
  </div></Card>
}

const strength = (n: WifiScanNetwork) => (n.rssi >= -67 ? 'Strong' : 'Weak')

function AddNetworkSheet({ state, refresh, initialSsid, onClose, onSend }: { state: CompanionState; refresh: () => Promise<void>; initialSsid: string; onClose: () => void; onSend: (ssid: string, blob: Promise<string>) => void }) {
  const id = state.device_id
  const [ssid, setSsid] = useState(initialSsid)
  const [reveal, setReveal] = useState(false)
  const [scanning, setScanning] = useState(true)
  const [scanError, setScanError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const password = useRef<HTMLInputElement>(null) // uncontrolled: the password lives in the field only
  const sheet = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  const seen = new Set<string>()
  const nearby = (state.last_wifi_scan?.networks ?? []).filter((n) => n.ssid).sort((a, b) => b.rssi - a.rssi).filter((n) => !seen.has(n.ssid) && !!seen.add(n.ssid)) // strongest entry per name

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    sheet.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus() }
  }, [])
  // Aelys scans when the sheet opens; the list fills in from its next report.
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => companion.scanWifi(id)).then(({ command_id }) => waitForCommand(id, command_id, () => live, SCAN_WAIT_MS)).then(() => live ? refresh() : undefined)
      .catch((e) => { if (live) setScanError(errorText(e)) })
      .finally(() => { if (live) setScanning(false) })
    return () => { live = false }
  }, [id, refresh])

  const submit = () => {
    const field = password.current
    const typed = field?.value ?? ''
    // Checked before anything is cleared, so a refused send loses nothing.
    if (byteLength(ssid) < 1 || byteLength(ssid) > MAX_SSID) { setFieldError('The network name can be 1 to 32 bytes long.'); return }
    if (byteLength(typed) > MAX_PASSWORD) { setFieldError('The password can be up to 64 bytes long.'); return }
    setFieldError('')
    if (field) field.value = ''
    onSend(ssid, encryptWifi(state.public_key, id, ssid, typed))
  }

  return <div className="dv-dim">
    <div className="dv-sheet dv-sheet--tall" role="dialog" aria-modal="true" aria-labelledby="dv-add-title" tabIndex={-1} ref={sheet}>
      <div className="dv-grab" />
      <div className="dv-sheet-bar"><div className="dv-sheet-title st-grow" id="dv-add-title">Add network</div><button type="button" className="dv-back" aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button></div>
      <div className="st-group-title dv-nearby-title">{scanning && <RefreshCw size={14} className="dv-spin" aria-hidden="true" />}Nearby · seen by Aelys</div>
      {scanError && <div className="st-error" role="alert">{scanError}</div>}
      <div className="dv-nearby">
        {nearby.map((n) => <button key={n.ssid} type="button" className="dv-net" data-testid="nearby" onClick={() => setSsid(n.ssid)}>
          <Wifi size={18} aria-hidden="true" />
          <span className="st-grow"><span className="st-label">{n.ssid}</span><span className="st-hint">{strength(n)}</span></span>
          {n.secure && <Lock size={14} aria-hidden="true" />}
          {n.ssid === ssid && <Check size={18} className="dv-picked" aria-hidden="true" />}
        </button>)}
      </div>
      <label className="st-label" htmlFor="dv-ssid">Network name</label>
      <input id="dv-ssid" className="st-input dv-tight" aria-label="Network name" maxLength={32} autoComplete="off" autoCapitalize="none" spellCheck={false} value={ssid} onChange={(e) => { setSsid(clampBytes(e.target.value, MAX_SSID)); setFieldError('') }} />
      <label className="st-label" htmlFor="dv-pw">Password</label>
      <div className="dv-pw">
        <input id="dv-pw" ref={password} className="st-input dv-tight" aria-label="Password" type={reveal ? 'text' : 'password'} maxLength={MAX_PASSWORD} autoComplete="new-password" onInput={(e) => { const f = e.currentTarget; const cut = clampBytes(f.value, MAX_PASSWORD); if (cut !== f.value) f.value = cut; setFieldError('') }} autoCapitalize="none" spellCheck={false} />
        <button type="button" className="dv-back" aria-label={reveal ? 'Hide password' : 'Show password'} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
      </div>
      {fieldError && <div className="st-error" role="alert">{fieldError}</div>}
      <button type="button" className="st-btn st-btn--primary dv-wide" disabled={!ssid} onClick={submit}>Send to Aelys</button>
    </div>
  </div>
}
