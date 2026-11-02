import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { CalendarDesktop } from './calendar/CalendarView.desktop'
import { CalendarMobile } from './calendar/CalendarView.mobile'

export function CalendarView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <CalendarMobile apiStatus={apiStatus} /> : <CalendarDesktop apiStatus={apiStatus} />
}
