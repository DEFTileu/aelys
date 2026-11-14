import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@aelys/shared'
import { Lock, Smartphone } from '../../../icons'
import { companion, reauth } from '../../../lib/companion/api'
import type { CompanionState } from '../../../lib/companion/types'
import { Card, Group, Row } from '../ui'
import { ReauthSheet } from './ReauthSheet'
import { WeatherOnAelys } from './WeatherOnAelys'

const FAILED = 'Something went wrong. Check the connection and try again.'
const DEBOUNCE_MS = 400
const MIN_BRIGHTNESS = 5 // the board's dimmest usable level
const errorText = (e: unknown) => (e instanceof ApiError && e.code === 'DEVICE_OFFLINE' ? 'Aelys is offline' : FAILED)

interface Props { state: CompanionState; onUnpaired: () => void }

export function DeviceSettingsPage({ state, onUnpaired }: Props) {
  const id = state.device_id
  const [brightness, setBrightness] = useState(() => Math.min(100, Math.max(MIN_BRIGHTNESS, state.settings?.brightness ?? 70)))
  const [error, setError] = useState('')
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<number | null>(null) // a value not yet sent
  const flush = () => {
    clearTimeout(timer.current)
    const value = pending.current; pending.current = null
    if (value === null) return
    companion.setSettings(id, { brightness: value }).then(
      () => { if (alive.current) setError('') },
      (e) => { if (alive.current) setError(errorText(e)) },
    )
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; flush() } }, [])
  const onBrightness = (value: number) => {
    setBrightness(value); pending.current = value
    clearTimeout(timer.current); timer.current = setTimeout(flush, DEBOUNCE_MS)
  }

  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState('')
  const restart = () => {
    setRestarting(true); setRestartError('')
    companion.restart(id).then(
      () => { setTimeout(() => { if (alive.current) setRestarting(false) }, 10_000) }, // it is back by then
      (e) => { if (alive.current) { setRestarting(false); setRestartError(errorText(e)) } },
    )
  }

  const [sheet, setSheet] = useState(false)
  const [unpairError, setUnpairError] = useState('')
  const attempt = useRef(0) // a cancelled attempt must not send anything when its fingerprint check returns late
  const unpair = async () => {
    if (state.lost_mode?.on) return // unpair erases lost mode on the board too (it would drop the owner's lost screen), so the app refuses until lost mode is off
    const mine = ++attempt.current
    setUnpairError(''); setSheet(true)
    try {
      const proof = await reauth('unpair', id)
      if (mine !== attempt.current) return
      await companion.unpair(id, proof)
      if (mine === attempt.current) { clearTimeout(timer.current); pending.current = null; onUnpaired() } // nothing more goes to the erased device
    } catch { if (mine === attempt.current) setUnpairError(FAILED) }
  }
  const cancel = () => { attempt.current++; setSheet(false); setUnpairError('') }

  return <>
    <Group title="Display and behavior">
      <Card>
        <div className="st-block">
          <div className="dv-split"><label className="st-label st-grow" htmlFor="dv-brightness">Brightness</label><span className="st-hint">{brightness}%</span></div>
          <input id="dv-brightness" type="range" className="dv-range" aria-label="Brightness" min={MIN_BRIGHTNESS} max={100} value={brightness} onChange={(e) => onBrightness(Number(e.target.value))} />
        </div>
      </Card>
      {error && <div className="st-error" role="alert">{error}</div>}
    </Group>
    <Group title="Weather on Aelys"><WeatherOnAelys /></Group>
    <Group title="Notifications on Aelys">
      <Card><Row title="Tasks, Calendar, Focus" hint="Titles only · always"><Lock size={18} aria-hidden="true" className="dv-lockicon" /></Row></Card>
    </Group>
    <Group title="Firmware">
      <Card>
        <div className="st-row"><span className="dv-it dv-it--violet"><Smartphone size={18} aria-hidden="true" /></span><div className="st-grow st-label">Version {state.fw_version ?? '—'}</div></div>
      </Card>
    </Group>
    <Card>
      <Row title="Restart Aelys" hint={restarting ? 'Restarting…' : 'Takes about 10 seconds'}>
        <button type="button" className="st-btn" disabled={restarting} onClick={restart}>Restart</button>
      </Row>
      {restartError && <div className="st-error" role="alert">{restartError}</div>}
    </Card>
    <Card>
      <Row title="Unpair Aelys" hint="Erases Aelys, its saved Wi-Fi and contacts. Requires your fingerprint"><button type="button" className="st-btn st-btn--danger" disabled={!!state.lost_mode?.on} onClick={() => void unpair()}>Unpair</button></Row>
    </Card>
    {sheet && <ReauthSheet error={unpairError} onCancel={cancel} hint="Erases Aelys, its saved Wi-Fi and contacts" />}
  </>
}
