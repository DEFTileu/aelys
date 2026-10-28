import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { ApiStatus } from '../types'

type Props = {
  status: ApiStatus
  title: string
  description: string
  action?: ReactNode
}

const icons = { loading: 'refresh', ready: 'inbox', empty: 'inbox', error: 'alert', offline: 'cloud-off' } as const

export function StateCard({ status, title, description, action }: Props) {
  return (
    <div className={`state-card state-card--${status}`} role={status === 'error' ? 'alert' : 'status'}>
      <span className="state-card__icon"><Icon name={icons[status]} size={20} /></span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
        {action}
      </div>
    </div>
  )
}
