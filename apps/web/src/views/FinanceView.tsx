import { StyledSelect } from '../components/controls/StyledSelect'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { FinanceAccount, FinanceBudget, FinanceCategory, FinanceSummary, FinanceTransaction } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import { decimalToUnits, formatMoney, sumDecimals } from '../lib/money'
import type { ApiStatus } from '../types'
import './connected.css'
import './actual-mail-finance.css'

type FormKind = 'account' | 'category' | 'budget' | 'transaction' | 'transfer'
const decimal = (value: string) => /^\d{1,16}(\.\d{1,4})?$/.test(value) && /[1-9]/.test(value)
const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const first = new Date(); first.setDate(1)
const next = new Date(first); next.setMonth(next.getMonth() + 1)

export function FinanceView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [accounts, setAccounts] = useState<readonly FinanceAccount[]>([])
  const [categories, setCategories] = useState<readonly FinanceCategory[]>([])
  const [budgets, setBudgets] = useState<readonly FinanceBudget[]>([])
  const [transactions, setTransactions] = useState<readonly FinanceTransaction[]>([])
  const [summary, setSummary] = useState<FinanceSummary | null>(null)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('KZT')
  const [categoryId, setCategoryId] = useState('')
  const [kind, setKind] = useState('expense')
  const [amount, setAmount] = useState('')
  const [recordDate, setRecordDate] = useState(() => inputDate(new Date()))
  const [periodStart, setPeriodStart] = useState(() => inputDate(first))
  const [periodEnd, setPeriodEnd] = useState(() => inputDate(next))
  const [accountId, setAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [notes, setNotes] = useState('')
  const [form, setForm] = useState<FormKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [notice, setNotice] = useState('')
  const [mobileRecord, setMobileRecord] = useState(false)
  const [historyType, setHistoryType] = useState('all')
  const [historyAccount, setHistoryAccount] = useState('all')
  const operationKey = useRef(crypto.randomUUID())
  const occurredAt = useRef(new Date().toISOString())
  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const [loadedAccounts, loadedCategories, loadedBudgets, loadedTransactions, loadedSummary] = await Promise.all([client.financeAccounts(), client.financeCategories(), client.financeBudgets(), client.financeTransactions(), client.financeSummary()])
      setAccounts(loadedAccounts); setCategories(loadedCategories); setBudgets(loadedBudgets); setTransactions(loadedTransactions); setSummary(loadedSummary)
      setAccountId((id) => { const account = loadedAccounts.find((item) => item.id === id) ?? loadedAccounts[0]; if (account) setCurrency(account.currency); return account?.id ?? '' })
      setStatus('ready')
    } catch (error) {
      setStatus(navigator.onLine ? 'error' : 'offline')
      setNotice(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Finance unavailable. Check your connection and owner session.')
    }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])
  const openForm = (value: FormKind) => {
    operationKey.current = crypto.randomUUID(); occurredAt.current = new Date().toISOString()
    setForm(value); setAmount(''); setName(''); setCategoryId(''); setNotes(''); setNotice('')
    const account = accounts.find((item) => item.id === accountId)
    if (account) setCurrency(account.currency)
    setToAccountId(accounts.find((item) => item.id !== accountId && item.currency === account?.currency)?.id ?? '')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || apiStatus !== 'ready') return
    setBusy(true); setNotice('')
    try {
      const client = getSharedApiClient()
      const options = { queueOnOffline: false, idempotencyKey: operationKey.current }
      if (form === 'account') await client.createFinanceAccount({ name: name.trim(), currency: currency.toUpperCase(), type: 'cash' }, options)
      else if (form === 'category') await client.createFinanceCategory({ name: name.trim(), kind }, options)
      else {
        const value = amount.trim()
        if (!decimal(value)) throw new Error('Enter a positive decimal amount with up to four decimal places.')
        if (form === 'budget') {
          const start = new Date(`${periodStart}T00:00:00`); const end = new Date(`${periodEnd}T00:00:00`)
          if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('Choose a budget end after its start.')
          await client.createFinanceBudget({ category_id: categoryId || null, currency: currency.toUpperCase(), period_start: start.toISOString(), period_end: end.toISOString(), limit_amount: value }, options)
        } else if (form === 'transfer') {
          if (!toAccountId || toAccountId === accountId) throw new Error('Choose two different accounts with the same currency.')
          await client.createFinanceTransfer({ from_account_id: accountId, to_account_id: toAccountId, amount: value, currency: currency.toUpperCase(), occurred_at: occurredAt.current, notes, idempotency_key: operationKey.current }, options)
        } else {
          const date = new Date(`${recordDate}T12:00:00`)
          if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid date.')
          await client.createFinanceTransaction({ account_id: accountId, category_id: categoryId || null, amount: value, currency: currency.toUpperCase(), type: kind, occurred_at: date.toISOString(), notes, idempotency_key: operationKey.current }, options)
        }
      }
      setForm(null); setMobileRecord(false); setAmount(''); setNotes(''); operationKey.current = crypto.randomUUID(); occurredAt.current = new Date().toISOString(); await load(); setNotice('Saved.')
    } catch (error) { setNotice(error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Could not save finance record.') }
    finally { setBusy(false) }
  }
  const selectedAccount = accounts.find((item) => item.id === accountId)
  const changeAccount = (id: string) => {
    setAccountId(id); setToAccountId('')
    const account = accounts.find((item) => item.id === id)
    if (account) setCurrency(account.currency)
  }
  // Phase 3 finance ledger: the mounted transactions endpoint returns the complete ledger.
  // Currency conversion and opening balances are not part of the current contract.
  const accountBalance = (account: FinanceAccount) => sumDecimals(transactions.filter((item) => item.account_id === account.id && item.currency === account.currency).map((item) => item.amount))
  const expenseUnits = (item: FinanceTransaction) => { const value = decimalToUnits(item.amount); return value < 0n ? -value : value }
  const spendingCurrencies = [...new Set(transactions.filter((item) => item.type === 'expense').map((item) => item.currency))]
  const palette = ['#6A4CF2', '#E88D4A', '#40A586', '#E66D88', '#598BD5', '#B77BC5']
  const history = transactions.filter((item) => (historyType === 'all' || item.type === historyType) && (historyAccount === 'all' || item.account_id === historyAccount))
  return <div className="connected-workspace actual-workspace actual-finance">
    <div className="actual-topline"><ApiStatusPill status={apiStatus}/><button className="button button--quiet" onClick={() => void load()}>Refresh</button></div>
    {apiStatus !== 'ready' && <p role="status">Finance is offline or unavailable. Previously loaded records may be shown from cache. Changes require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {notice && <p role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading ledger' : 'Finance unavailable'} description="Check the connection and owner session."/> : <>
      <section className="actual-finance-mobile-total" aria-label="Balance">
        {summary?.currencies?.length ? summary.currencies.map((item) => <div key={item.currency}><span>Total balance · {item.currency}</span><strong>{item.balance}</strong></div>) : <span>No currency balances yet.</span>}
        <div className="actual-mobile-record-actions">{(['expense', 'income'] as const).map((type) => <button type="button" key={type} onClick={() => { setForm(null); setKind(type); setCategoryId(''); setMobileRecord(true) }}>{type === 'expense' ? '↗ Expense' : '↙ Income'}</button>)}</div>
      </section>
      <section className="actual-accounts" aria-label="Accounts">
        {accounts.map((item) => <button type="button" key={item.id} className="actual-account" aria-pressed={accountId === item.id} onClick={() => changeAccount(item.id)}><span className="actual-account-heading"><span className="actual-icon" aria-hidden="true">◈</span><strong>{item.name}</strong><span className="actual-badge">{item.currency}</span></span><span className="actual-account-balance">{formatMoney(accountBalance(item))} {item.currency}</span><span className="actual-account-type">{item.type}</span></button>)}
        <button type="button" className="actual-new-account" disabled={busy} onClick={() => openForm('account')}>Add account</button>
      </section>
      <div className="actual-finance-columns"><div className="actual-finance-left">
        {(form === null || form === 'transaction') && <form className={`actual-panel actual-record ${mobileRecord ? 'actual-record-open' : ''}`} onSubmit={submit}>
          <div className="actual-record-title"><h2>Record</h2><button type="button" className="actual-record-close" onClick={() => setMobileRecord(false)} aria-label="Close record">×</button></div>
          <div className="actual-record-types" role="radiogroup" aria-label="Transaction type">{(['expense', 'income'] as const).map((type) => <button type="button" role="radio" aria-checked={kind === type} key={type} onClick={() => { setKind(type); setCategoryId('') }}>{type === 'expense' ? '↗ Expense' : '↙ Income'}</button>)}</div>
          <label>Amount<span className="actual-amount"><input required aria-label="Amount (decimal)" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00"/><span>{selectedAccount?.currency ?? currency}</span></span></label>
          <div className="actual-record-fields"><label>Account<StyledSelect aria-label="Account" required value={accountId} onChange={(event) => changeAccount(event.target.value)}><option value="">Choose account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</StyledSelect></label><label>Category<StyledSelect aria-label="Category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Uncategorized</option>{categories.filter((item) => item.kind === kind).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</StyledSelect></label><label>Date<input required type="date" value={recordDate} onChange={(event) => setRecordDate(event.target.value)}/></label><label>Note<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional"/></label></div>
          <div className="actual-record-mobile-choices"><span>Account</span><div>{accounts.map((item) => <button key={item.id} type="button" aria-pressed={accountId === item.id} onClick={() => changeAccount(item.id)}>{item.name}</button>)}</div><span>Category</span><div><button type="button" aria-pressed={!categoryId} onClick={() => setCategoryId('')}>Uncategorized</button>{categories.filter((item) => item.kind === kind).map((item) => <button key={item.id} type="button" aria-pressed={categoryId === item.id} onClick={() => setCategoryId(item.id)}>{item.name}</button>)}</div></div>
          <button className="button button--primary actual-record-submit" disabled={busy || apiStatus !== 'ready' || !accountId}>{busy ? 'Saving…' : `Record ${kind}`}</button>
          <button type="button" className="actual-transfer-link" disabled={busy} onClick={() => openForm('transfer')}>Transfer between accounts</button>
        </form>}
      {form && form !== 'transaction' && <form className="connected-card settings-form" onSubmit={submit}>
        <h2>{`New ${form}`}</h2><fieldset disabled={busy} style={{ border: 0, padding: 0, display: 'grid', gap: 12 }}>
          {(form === 'account' || form === 'category') && <label>Name<input required value={name} onChange={(event) => setName(event.target.value)}/></label>}
          {form === 'category' && <label>Type<StyledSelect aria-label="Category type" value={kind} onChange={(event) => { setKind(event.target.value); setCategoryId('') }}><option value="expense">Expense</option><option value="income">Income</option></StyledSelect></label>}
          {form === 'transfer' && <label>From account<StyledSelect aria-label="From account" required value={accountId} onChange={(event) => changeAccount(event.target.value)}><option value="">Choose account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</StyledSelect></label>}
          {form === 'transfer' && <label>To account<StyledSelect aria-label="To account" required value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}><option value="">Choose destination</option>{accounts.filter((item) => item.id !== accountId && item.currency === selectedAccount?.currency).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</StyledSelect></label>}
          {form === 'budget' && <label>Category<StyledSelect aria-label="Category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">All / uncategorized</option>{categories.filter((item) => item.kind === (form === 'budget' ? 'expense' : kind)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</StyledSelect></label>}
          {form !== 'category' && <label>Currency<input required pattern="[A-Za-z]{3}" readOnly={form === 'transfer'} minLength={3} maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value)}/></label>}
          {!['category', 'account'].includes(form) && <label>{form === 'budget' ? 'Limit (decimal)' : 'Amount (decimal)'}<input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1250.00"/></label>}
          {form === 'budget' && <><label>Period start<input required type="date" value={periodStart} onInput={(event) => setPeriodStart(event.currentTarget.value)} onChange={(event) => setPeriodStart(event.target.value)}/></label><label>Period end (exclusive)<input required type="date" value={periodEnd} onInput={(event) => setPeriodEnd(event.currentTarget.value)} onChange={(event) => setPeriodEnd(event.target.value)}/></label></>}
          {form === 'transfer' && <label>Notes<input value={notes} onChange={(event) => setNotes(event.target.value)}/></label>}
          <div><button className="button button--primary" disabled={busy || apiStatus !== 'ready'}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="button button--quiet" onClick={() => setForm(null)}>Cancel</button></div>
        </fieldset>
      </form>}
      <section className="actual-panel actual-summary"><h2>Summary</h2><p>{summary?.count ?? 0} transactions</p>{summary?.currencies?.length ? summary.currencies.map((item) => <div className="actual-summary-currency" key={item.currency}><strong>{item.currency}</strong><b>{item.balance}</b><span>Income {item.income}</span><span>Spent {item.expense}</span></div>) : <p>No currency balances yet.</p>}{spendingCurrencies.map((currencyCode) => {
        const grouped = new Map<string, bigint>()
        transactions.filter((item) => item.type === 'expense' && item.currency === currencyCode).forEach((item) => {
          const key = item.category_id || ''
          grouped.set(key, (grouped.get(key) ?? 0n) + expenseUnits(item))
        })
        const entries = [...grouped.entries()].filter(([, value]) => value > 0n).sort((a, b) => a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1)
        const total = entries.reduce((sum, [, value]) => sum + value, 0n)
        if (!total) return null
        let offset = 0
        const segments = entries.map(([id, value], index) => {
          // Only the visual percentage is converted to a number, after integer division.
          const percent = Number(value * 10000n / total) / 100
          const start = offset; offset += percent
          return { id, value, percent, start, color: palette[index % palette.length]! }
        })
        const gradient = segments.map((item) => `${item.color} ${item.start}% ${item.start + item.percent}%`).join(', ')
        return <div className="actual-finance-breakdown" key={currencyCode}><h3>Spending by category · {currencyCode}</h3><div className="actual-finance-chart"><div className="actual-finance-donut" aria-hidden="true" style={{ background: `conic-gradient(${gradient})` }}><span>{formatMoney(total)}<small>{currencyCode} spent</small></span></div><ul>{segments.map((item) => <li key={item.id}><i style={{ background: item.color }}/><span>{item.id ? categories.find((category) => category.id === item.id)?.name ?? 'Unknown category' : 'Uncategorized'}</span><b>{formatMoney(item.value)}</b></li>)}</ul></div></div>
      })}</section>
      {budgets.length > 0 && <section className="actual-panel actual-finance-budgets"><h2>Budgets</h2>{budgets.map((budget) => {
        const spent = transactions.filter((item) => item.type === 'expense' && item.currency === budget.currency && (!budget.category_id || item.category_id === budget.category_id) && Date.parse(item.occurred_at) >= Date.parse(budget.period_start) && Date.parse(item.occurred_at) < Date.parse(budget.period_end)).reduce((sum, item) => sum + expenseUnits(item), 0n)
        const limit = decimalToUnits(budget.limit_amount)
        const progress = limit > 0n ? Number((spent >= limit ? limit : spent) * 10000n / limit) / 100 : 0
        return <div className="actual-finance-budget" key={budget.id}><div><strong>{budget.category_id ? categories.find((category) => category.id === budget.category_id)?.name ?? 'Unknown category' : 'All categories'}</strong><span>{formatMoney(spent)} / {formatMoney(limit)} {budget.currency}</span></div><div className="actual-finance-progress" role="progressbar" aria-label={`${budget.category_id ? categories.find((category) => category.id === budget.category_id)?.name ?? 'Unknown category' : 'All categories'} budget`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div><small>{new Date(budget.period_start).toLocaleDateString()} – {new Date(budget.period_end).toLocaleDateString()} (end exclusive)</small></div>
      })}</section>}
      <details className="actual-panel actual-finance-tools"><summary>Categories &amp; budgets</summary><div className="actual-actions"><button className="button button--quiet" disabled={busy} onClick={() => openForm('category')}>Add category</button><button className="button button--quiet" disabled={busy} onClick={() => openForm('budget')}>Add budget</button></div><h3>Categories</h3>{categories.length ? categories.map((item) => <p key={item.id}>{item.name} · {item.kind}</p>) : <p>No categories yet.</p>}<h3>Budgets</h3>{budgets.length ? budgets.map((item) => <p key={item.id}>{categories.find((category) => category.id === item.category_id)?.name ?? 'All categories'}: {item.limit_amount} {item.currency} · {new Date(item.period_start).toLocaleDateString()} – {new Date(item.period_end).toLocaleDateString()}</p>) : <p>No budgets yet.</p>}</details>
      </div><section className="actual-panel actual-history"><div className="actual-history-head"><h2>History</h2><div className="actual-filter" aria-label="Filter history by type">{(['all', 'expense', 'income'] as const).map((value) => <button type="button" key={value} aria-pressed={historyType === value} onClick={() => setHistoryType(value)}>{value === 'all' ? 'All' : value === 'expense' ? 'Expense' : 'Income'}</button>)}</div><StyledSelect aria-label="Filter by account" value={historyAccount} onChange={(event) => setHistoryAccount(event.target.value)}><option value="all">All accounts</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</StyledSelect></div>
        {history.length ? history.map((item) => <article className="actual-history-row" key={item.id}><span className="actual-icon" aria-hidden="true">{item.type === 'income' ? '↗' : '↙'}</span><div><strong>{item.notes || categories.find((category) => category.id === item.category_id)?.name || 'Uncategorized'}</strong><small>{accounts.find((account) => account.id === item.account_id)?.name ?? 'Unknown account'} · {item.type} · {new Date(item.occurred_at).toLocaleDateString()}</small></div><b>{item.amount} {item.currency}</b></article>) : <p className="actual-empty">{transactions.length ? 'No transactions for these filters.' : 'No transactions yet.'}</p>}
      </section></div>
    </>}
  </div>
}
