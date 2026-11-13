import { ChevronRight, MapPin, Sliders, TriangleAlert, Volume2, Wifi } from '../../../icons'
import type { CompanionState } from '../../../lib/companion/types'
import { Card } from '../ui'

export type Page = 'overview' | 'lost' | 'emergency' | 'wifi' | 'settings'
/** One "Find" command shared by the overview and the lost-mode page. */
export interface FindControl { run: () => void; busy: boolean; error: string }

const pad = (n: number) => String(n).padStart(2, '0')
/** "14:05" in the viewer's time zone. */
export function hhmm(iso: string | null | undefined): string | null {
  const date = iso ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime()) ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : null
}
export const batteryPct = (s: CompanionState) => s.battery?.pct ?? s.last_metrics?.battery_pct ?? null

const MODEL = 'Waveshare AMOLED 1.75″' // the only board there is; the API does not report a model

export function CompanionOverview({ state, find, onGo }: { state: CompanionState; find: FindControl; onGo: (page: Page) => void }) {
  const seen = hhmm(state.last_seen_at)
  const pct = batteryPct(state)
  const contacts = state.ice?.contacts?.length ?? 0
  const saved = state.wifi?.saved?.length ?? 0
  const current = state.wifi?.current
  const stat = (value: string, label: string) => <div className="dv-stat"><b>{value}</b><span className="st-hint">{label}</span></div>
  return <>
    <Card>
      <div className="st-row">
        <div className="st-grow">
          <div className="st-label">{state.display_name || 'Aelys'}</div>
          <div className="dv-online" data-online={state.online}><span className="st-dot" />{state.online ? 'Online · seen now' : seen ? `Last seen ${seen}` : 'Offline'}</div>
          <div className="st-hint">{MODEL}</div>
        </div>
      </div>
      <div className="dv-stats">{stat(pct === null ? '—' : `${pct}%`, 'Battery')}{stat(current || '—', 'Wi-Fi')}{stat(state.fw_version || '—', 'Firmware')}</div>
    </Card>
    <div className="st-group">
      <div className="st-group-title">Quick actions</div>
      <div className="dv-tiles">
        <button type="button" className="dv-tile" disabled={find.busy} onClick={find.run}><span className="dv-it dv-it--violet"><Volume2 size={18} aria-hidden="true" /></span><b>Find</b><span className="st-hint">Play sound</span></button>
        <button type="button" className="dv-tile" onClick={() => onGo('lost')}><span className="dv-it dv-it--amber"><MapPin size={18} aria-hidden="true" /></span><b>Lost mode</b><span className="st-hint">{state.lost_mode?.on ? 'On' : 'Off'}</span></button>
        <button type="button" className="dv-tile" onClick={() => onGo('emergency')}><span className="dv-it dv-it--red"><TriangleAlert size={18} aria-hidden="true" /></span><b>Emergency</b><span className="st-hint">{contacts === 1 ? '1 contact' : `${contacts} contacts`}</span></button>
      </div>
      {find.error && <div className="st-error" role="alert">{find.error}</div>}
    </div>
    <Card>
      <button type="button" className="st-row dv-nav" onClick={() => onGo('wifi')}><span className="dv-it dv-it--green"><Wifi size={18} aria-hidden="true" /></span><span className="st-grow"><span className="st-label">Wi-Fi networks</span><span className="st-hint">{saved} saved{current ? ` · ${current} connected` : ''}</span></span><ChevronRight size={18} aria-hidden="true" /></button>
      <button type="button" className="st-row dv-nav" onClick={() => onGo('settings')}><span className="dv-it dv-it--violet"><Sliders size={18} aria-hidden="true" /></span><span className="st-grow"><span className="st-label">Device settings</span><span className="st-hint">Display, sounds, privacy, firmware</span></span><ChevronRight size={18} aria-hidden="true" /></button>
    </Card>
  </>
}
