import type { ReactNode } from 'react'
import { CloudOff, Inbox, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ApiStatus } from '../types'

type Props = {
  status: ApiStatus
  title: string
  description: string
  action?: ReactNode
}

const icons: Record<ApiStatus, LucideIcon> = { loading: RefreshCw, ready: Inbox, empty: Inbox, error: TriangleAlert, offline: CloudOff }

export function StateCard({ status, title, description, action }: Props) {
  const Icon = icons[status]
  return (
    <div className={`mod-state mod-state--${status}`} role={status === 'error' ? 'alert' : 'status'}>
      <span className="mod-state__icon"><Icon size={22} aria-hidden="true" /></span>
      <strong className="mod-state__title">{title}</strong>
      <p className="mod-state__desc">{description}</p>
      {action && <div className="mod-state__action">{action}</div>}
    </div>
  )
}
