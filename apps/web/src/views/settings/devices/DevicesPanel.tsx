import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@aelys/shared'
import { ArrowLeft, ChevronRight, Plus, Smartphone } from '../../../icons'
import { companion } from '../../../lib/companion/api'
import { CompanionSerial } from '../../../lib/companion/serial'
import type { CompanionDevice, CompanionState } from '../../../lib/companion/types'
import { Card } from '../ui'
import { AddCompanion } from './AddCompanion'
import { CompanionOverview, type FindControl, type Page } from './CompanionOverview'
import { LostModePage } from './LostModePage'
import './devices.css'

const POLL_MS = 5000
const PAGES: readonly Page[] = ['overview', 'lost', 'emergency', 'wifi', 'settings']
const FAILED = 'Something went wrong. Check the connection and try again.'

// The sub-page lives in the URL: ?section=devices&device=<id>&page=overview|lost|emergency|wifi|settings
function readRoute(): { device: string | null; page: Page } {
  const query = new URLSearchParams(window.location.search)
  const page = query.get('page') as Page
  return { device: query.get('device'), page: PAGES.includes(page) ? page : 'overview' }
}
function navigate(device?: string, page?: Page) {
  const query = new URLSearchParams({ section: 'devices' })
  if (device) { query.set('device', device); query.set('page', page ?? 'overview') }
  window.history.pushState({}, '', `?${query}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function useRoute() {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const onPopState = () => setRoute(readRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  return route
}

const statusLine = (d: CompanionDevice) => [d.online ? 'Online' : 'Offline', d.wifi_current, d.battery_pct === null || d.battery_pct === undefined ? null : `${d.battery_pct}%`].filter(Boolean).join(' · ')

function DeviceList() {
  const [devices, setDevices] = useState<CompanionDevice[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => companion.list()).then((list) => live && setDevices(Array.isArray(list) ? list : []), () => { if (live) { setDevices([]); setFailed(true) } })
    return () => { live = false }
  }, [])
  if (!devices) return null

  const supported = CompanionSerial.supported()
  return <>
    {failed && <div className="st-error" role="alert">Couldn't load your devices. Check the connection and reopen this page.</div>}
    {devices.length > 0 && <Card>
      {devices.map((d) => <button key={d.device_id} type="button" className="st-row dv-nav" onClick={() => navigate(d.device_id)}>
        <span className="dv-it dv-it--violet"><Smartphone size={18} aria-hidden="true" /></span>
        <span className="st-grow"><span className="st-label">{d.display_name || 'Aelys'}</span><span className="st-hint dv-status" data-online={d.online}><span className="st-dot" />{statusLine(d)}</span></span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>)}
    </Card>}
    {devices.length > 0 && supported && !adding
      ? <button type="button" className="st-btn st-btn--ghost dv-wide" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add companion</button>
      : <AddCompanion />}
  </>
}

/** Latest state of one companion, refreshed every 5 s while the page is visible. */
function useDeviceState(id: string) {
  const [state, setState] = useState<CompanionState | null>(null)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    try {
      const next = await companion.state(id)
      if (alive.current) { setState(next); setFailed(false) }
    } catch { if (alive.current) setFailed(true) } // offline or a cache miss: keep what is shown
  }, [id])
  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, POLL_MS)
    return () => { alive.current = false; clearInterval(timer) }
  }, [refresh])
  return { state, failed, refresh }
}

function DevicePage({ id, page, owner }: { id: string; page: Page; owner: { name: string | null; email: string | null } | undefined }) {
  const { state, failed, refresh } = useDeviceState(id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const find: FindControl = {
    busy, error,
    run: () => {
      setBusy(true); setError('')
      companion.find(id).catch((e) => setError(e instanceof ApiError && e.code === 'DEVICE_OFFLINE' ? 'Aelys is offline' : FAILED)).finally(() => setBusy(false))
    },
  }
  const lost = page === 'lost'
  return <>
    <div className="dv-bar">
      <button type="button" className="dv-back" aria-label="Back" onClick={() => navigate(lost ? id : undefined, lost ? 'overview' : undefined)}><ArrowLeft size={20} aria-hidden="true" /></button>
      <h3 className="dv-bar-title">{lost ? 'Lost mode' : state?.display_name || 'Aelys'}</h3>
    </div>
    {!state && failed && <div className="st-error" role="alert">Couldn't reach Aelys. Check the connection; this page keeps trying.</div>}
    {state && (lost
      ? <LostModePage state={state} owner={owner} find={find} refresh={refresh} />
      : <CompanionOverview state={state} find={find} onGo={(next) => navigate(id, next)} />)}
  </>
}

// shortcut: the Wi-Fi, Emergency and Device settings pages are separate tasks; until they land those rows open the overview.
export function DevicesPanel({ owner }: { owner?: { name: string | null; email: string | null } }) {
  const { device, page } = useRoute()
  return device ? <DevicePage key={device} id={device} page={page} owner={owner} /> : <DeviceList />
}
