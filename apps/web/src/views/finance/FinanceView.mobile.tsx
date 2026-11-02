import { Plus } from '../../icons'
import { PageSkeleton } from '../../components/PageSkeleton'
import type { ApiStatus } from '../../types'
import '../connected.css'
import '../actual-mail-finance.css'
import './finance-mobile.css'
import { FinanceAccounts, FinanceBalance, FinanceBudgets, FinanceForm, FinanceHistory, FinanceRecord, FinanceSummary, FinanceTools } from './FinanceShared'
import { useFinance } from './useFinance'

// The balance, accounts and history are the screen; recording opens as a bottom sheet from the FAB.
export function FinanceMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const f = useFinance(apiStatus)
  const { status, notice, mobileRecord, setMobileRecord, setForm, setKind, setCategoryId, busy, load } = f
  return <div className="connected-workspace actual-workspace actual-finance finance-m">
    {apiStatus !== 'ready' && <p role="status">Finance is offline or unavailable. Previously loaded records may be shown from cache. Changes require a connection.</p>}
    {notice && <p role="status">{notice}</p>}
    {status !== 'ready' ? <PageSkeleton kind="grid" label="finances" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} /> : <>
      <FinanceBalance {...f} />
      <FinanceAccounts {...f} />
      <FinanceForm {...f} />
      <FinanceHistory {...f} />
      <details className="finance-m-more"><summary>Summary and budgets</summary><FinanceSummary {...f} /><FinanceBudgets {...f} /></details>
      <FinanceTools {...f} />
      {mobileRecord && <FinanceRecord {...f} />}
      {!mobileRecord && <button type="button" className="finance-m-fab" aria-label="Record transaction" disabled={busy} onClick={() => { setForm(null); setKind('expense'); setCategoryId(''); setMobileRecord(true) }}><Plus size={24} /></button>}
    </>}
  </div>
}
