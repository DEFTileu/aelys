import { CloudOff, TriangleAlert, Wifi, RefreshCw, type AelysIconComponent } from '../icons'
import type { ApiStatus } from '../types'

const copy: Record<ApiStatus, string> = {
  loading: 'Checking connection',
  ready: 'API connected',
  empty: 'No data yet',
  error: 'API unavailable',
  offline: 'Offline',
}

const icons: Record<ApiStatus, AelysIconComponent> = { loading: RefreshCw, ready: Wifi, empty: Wifi, error: TriangleAlert, offline: CloudOff }

export function ApiStatusPill({ status }: { status: ApiStatus }) {
  const Icon = icons[status]
  return <span className={`mod-pill mod-pill--${status}`}><Icon size={13} aria-hidden="true" />{copy[status]}</span>
}
