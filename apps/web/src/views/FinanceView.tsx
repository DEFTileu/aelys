import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { FinanceDesktop } from './finance/FinanceView.desktop'
import { FinanceMobile } from './finance/FinanceView.mobile'

export function FinanceView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <FinanceMobile apiStatus={apiStatus} /> : <FinanceDesktop apiStatus={apiStatus} />
}
