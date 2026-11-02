import { PageSkeleton } from '../../components/PageSkeleton'
import type { ApiStatus } from '../../types'
import '../connected.css'
import '../actual-mail-finance.css'
import '../desktop/page-tokens.css'
import '../desktop/finance.css'
import { FinanceAccounts, FinanceBalance, FinanceBudgets, FinanceForm, FinanceHistory, FinanceRecord, FinanceSummary, FinanceTools } from './FinanceShared'
import { useFinance } from './useFinance'

export function FinanceDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const f = useFinance(apiStatus)
  const { status, notice, load } = f
  return <div className="connected-workspace actual-workspace actual-finance">
    {apiStatus !== 'ready' && <p role="status">Finance is offline or unavailable. Previously loaded records may be shown from cache. Changes require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {notice && <p role="status">{notice}</p>}
    {status !== 'ready' ? <PageSkeleton kind="grid" label="finances" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} /> : <>
      <FinanceBalance {...f} />
      <FinanceAccounts {...f} />
      <div className="actual-finance-columns"><div className="actual-finance-left">
        <FinanceRecord {...f} />
        <FinanceForm {...f} />
        <FinanceSummary {...f} />
        <FinanceBudgets {...f} />
        <FinanceTools {...f} />
      </div><FinanceHistory {...f} /></div>
    </>}
  </div>
}
