import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { FinanceAccount, FinanceBudget, FinanceCategory, FinanceSummary, FinanceTransaction } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './connected.css'

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
  const [periodStart, setPeriodStart] = useState(() => inputDate(first))
  const [periodEnd, setPeriodEnd] = useState(() => inputDate(next))
  const [accountId, setAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [notes, setNotes] = useState('')
  const [form, setForm] = useState<FormKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [notice, setNotice] = useState('')
  const operationKey = useRef(crypto.randomUUID())
  const occurredAt = useRef(new Date().toISOString())
  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const [loadedAccounts, loadedCategories, loadedBudgets, loadedTransactions, loadedSummary] = await Promise.all([client.financeAccounts(), client.financeCategories(), client.financeBudgets(), client.financeTransactions(), client.financeSummary()])
      setAccounts(loadedAccounts); setCategories(loadedCategories); setBudgets(loadedBudgets); setTransactions(loadedTransactions); setSummary(loadedSummary)
      setAccountId((id) => loadedAccounts.some((item) => item.id === id) ? id : loadedAccounts[0]?.id ?? '')
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
        } else await client.createFinanceTransaction({ account_id: accountId, category_id: categoryId || null, amount: value, currency: currency.toUpperCase(), type: kind, occurred_at: occurredAt.current, notes, idempotency_key: operationKey.current }, options)
      }
      setForm(null); await load(); setNotice('Saved.')
    } catch (error) { setNotice(error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Could not save finance record.') }
    finally { setBusy(false) }
  }
  const selectedAccount = accounts.find((item) => item.id === accountId)
  const changeAccount = (id: string) => {
    setAccountId(id); setToAccountId('')
    const account = accounts.find((item) => item.id === id)
    if (account) setCurrency(account.currency)
  }
  return <div className="connected-workspace">
    <div className="connected-toolbar"><ApiStatusPill status={apiStatus}/>{(['transaction', 'transfer', 'account', 'category', 'budget'] as const).map((value) => <button key={value} className="button button--quiet" disabled={busy} onClick={() => openForm(value)}>{value === 'transfer' ? 'Transfer' : `Add ${value}`}</button>)}<button className="button button--quiet" onClick={() => void load()}>Refresh</button></div>
    {apiStatus !== 'ready' && <p role="status">Finance is offline or unavailable. Previously loaded records may be shown from cache. Changes require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {notice && <p role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading ledger' : 'Finance unavailable'} description="Check the connection and owner session."/> : <>
      <section className="connected-card"><h2>Summary</h2><p>{summary?.count ?? 0} transactions</p>{summary?.currencies?.length ? summary.currencies.map((item) => <p key={item.currency}>{item.currency}: balance {item.balance} · income {item.income} · expenses {item.expense}</p>) : <p>No currency balances yet.</p>}</section>
      {form && <form className="connected-card settings-form" onSubmit={submit}>
        <h2>New {form}</h2><fieldset disabled={busy} style={{ border: 0, padding: 0, display: 'grid', gap: 12 }}>
          {(form === 'account' || form === 'category') && <label>Name<input required value={name} onChange={(event) => setName(event.target.value)}/></label>}
          {(form === 'category' || form === 'transaction') && <label>Type<select value={kind} onChange={(event) => { setKind(event.target.value); setCategoryId('') }}><option value="expense">Expense</option><option value="income">Income</option></select></label>}
          {(form === 'transaction' || form === 'transfer') && <label>From account<select required value={accountId} onChange={(event) => changeAccount(event.target.value)}><option value="">Choose account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></label>}
          {form === 'transfer' && <label>To account<select required value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}><option value="">Choose destination</option>{accounts.filter((item) => item.id !== accountId && item.currency === selectedAccount?.currency).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></label>}
          {(form === 'transaction' || form === 'budget') && <label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">All / uncategorized</option>{categories.filter((item) => item.kind === (form === 'budget' ? 'expense' : kind)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          {form !== 'category' && <label>Currency<input required pattern="[A-Za-z]{3}" readOnly={form === 'transaction' || form === 'transfer'} minLength={3} maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value)}/></label>}
          {!['category', 'account'].includes(form) && <label>{form === 'budget' ? 'Limit (decimal)' : 'Amount (decimal)'}<input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1250.00"/></label>}
          {form === 'budget' && <><label>Period start<input required type="date" value={periodStart} onInput={(event) => setPeriodStart(event.currentTarget.value)} onChange={(event) => setPeriodStart(event.target.value)}/></label><label>Period end (exclusive)<input required type="date" value={periodEnd} onInput={(event) => setPeriodEnd(event.currentTarget.value)} onChange={(event) => setPeriodEnd(event.target.value)}/></label></>}
          {(form === 'transaction' || form === 'transfer') && <label>Notes<input value={notes} onChange={(event) => setNotes(event.target.value)}/></label>}
          <div><button className="button button--primary" disabled={busy || apiStatus !== 'ready'}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="button button--quiet" onClick={() => setForm(null)}>Cancel</button></div>
        </fieldset>
      </form>}
      <section className="connected-card"><h2>Accounts</h2>{accounts.length ? accounts.map((item) => <p key={item.id}>{item.name} · {item.currency} · {item.type}</p>) : <StateCard status="empty" title="No accounts yet" description="Create an account before adding transactions."/>}</section>
      <section className="connected-card"><h2>Categories</h2>{categories.length ? categories.map((item) => <p key={item.id}>{item.name} · {item.kind}</p>) : <StateCard status="empty" title="No categories yet" description="Create categories to classify transactions."/>}</section>
      <section className="connected-card"><h2>Budgets</h2>{budgets.length ? budgets.map((item) => <p key={item.id}>{categories.find((category) => category.id === item.category_id)?.name ?? 'All categories'}: {item.limit_amount} {item.currency} · {new Date(item.period_start).toLocaleDateString()} – {new Date(item.period_end).toLocaleDateString()}</p>) : <StateCard status="empty" title="No budgets yet" description="Create a budget to track planned spending."/>}</section>
      <section className="connected-card"><h2>Transactions</h2>{transactions.length ? transactions.map((item) => <article className="finance-row" key={item.id}><strong>{item.amount} {item.currency}</strong><span>{accounts.find((account) => account.id === item.account_id)?.name} · {item.type} · {categories.find((category) => category.id === item.category_id)?.name ?? 'Uncategorized'} · {item.notes || 'No note'}</span></article>) : <StateCard status="empty" title="No transactions yet" description="Create a decimal transaction to start the ledger."/>}</section>
    </>}
  </div>
}
