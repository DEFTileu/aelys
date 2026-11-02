import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { TimerDesktop } from './timer/TimerView.desktop'
import { TimerMobile } from './timer/TimerView.mobile'

export function TimerView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <TimerMobile apiStatus={apiStatus} /> : <TimerDesktop apiStatus={apiStatus} />
}
