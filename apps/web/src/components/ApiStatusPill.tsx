import { Icon } from './Icon'
import type { ApiStatus } from '../types'

const copy: Record<ApiStatus, string> = {
  loading: 'Checking connection',
  ready: 'API connected',
  empty: 'No data yet',
  error: 'API unavailable',
  offline: 'Offline',
}

export function ApiStatusPill({ status }: { status: ApiStatus }) {
  return <span className={`status-pill status-pill--${status}`}><Icon name={status === 'offline' ? 'cloud-off' : status === 'error' ? 'alert' : status === 'loading' ? 'refresh' : 'wifi'} size={14} />{copy[status]}</span>
}
