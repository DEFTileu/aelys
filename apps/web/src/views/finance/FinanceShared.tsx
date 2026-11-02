import { StyledSelect } from '../../components/controls/StyledSelect'
import { ApiStatusPill } from '../../components/ApiStatusPill'
import { ArrowDownLeft, ArrowUpRight, Info, Plus, Wallet } from '../../icons'
import { decimalToUnits, formatMoney } from '../../lib/money'
import { fmtDay } from '../tasks/taskModel'
import type { useFinance } from './useFinance'
import type { FinanceTransaction } from '@aelys/shared'

export type FinanceHook = ReturnType<typeof useFinance>

// Exact grouped display ("192 120.00 ₸", "$1 205.00"): integer and fraction digits come straight from the fixed-point value.
const SYMBOLS: Record<string, [string, 'before' | 'after']> = { KZT: ['₸', 'after'], USD: ['$', 'before'], EUR: ['€', 'before'], RUB: ['₽', 'after'] }
function displayMoney(units: bigint, currency: string, sign: 'none' | 'always' = 'none'): string {
  const raw = formatMoney(units < 0n ? -units : units)
  const [whole, fraction] = raw.split('.')
  const grouped = `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${fraction}`
  const [symbol, side] = SYMBOLS[currency.toUpperCase()] ?? [currency.toUpperCase(), 'after']
  const text = side === 'before' ? `${symbol}${grouped}` : `${grouped} ${symbol}`
  const mark = units < 0n ? '− ' : sign === 'always' && units > 0n ? '+ ' : ''
  return `${mark}${text}`
}
const symbolOf = (currency: string) => SYMBOLS[currency.toUpperCase()]?.[0] ?? currency.toUpperCase()
const CAT_COLORS = ['#D97706', '#2F6FE4', '#6A4CF2', '#E2553F', '#14966C', '#D9367E', '#0F9488']
const catColor = (name: string) => CAT_COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % CAT_COLORS.length]!
const palette = ['#6A4CF2', '#E88D4A', '#40A586', '#E66D88', '#598BD5', '#B77BC5']
const expenseUnits = (item: FinanceTransaction) => { const value = decimalToUnits(item.amount); return value < 0n ? -value : value }

export function FinanceBalance({ summary, setForm, setKind, setCategoryId, setMobileRecord }: FinanceHook) {
  return <section className="actual-finance-mobile-total" aria-label="Balance">
    {summary?.currencies?.length ? summary.currencies.map((item) => <div key={item.currency}><span>Total balance · {item.currency}</span><strong>{item.balance}</strong></div>) : <span>No currency balances yet.</span>}
    <div className="actual-mobile-record-actions">{(['expense', 'income'] as const).map((type) => <button type="button" key={type} onClick={() => { setForm(null); setKind(type); setCategoryId(''); setMobileRecord(true) }}>{type === 'expense' ? '↗ Expense' : '↙ Income'}</button>)}</div>
  </section>
}

export function FinanceAccounts({ accounts, accountId, changeAccount, accountBalance, busy, openForm }: FinanceHook) {
  return <section className="actual-accounts" aria-label="Accounts">
    {accounts.map((item) => <button type="button" key={item.id} className="actual-account" aria-pressed={accountId === item.id} onClick={() => changeAccount(item.id)}><span className="actual-account-heading"><span className="actual-icon" aria-hidden="true"><Wallet size={17} /></span><strong>{item.name}</strong><span className="actual-badge">{item.currency}</span></span><span className="actual-account-balance">{displayMoney(accountBalance(item), item.currency)}</span></button>)}
    <button type="button" className="actual-new-account" disabled={busy} onClick={() => openForm('account')}><Plus size={18} />New account</button>
  </section>
}

export function FinanceRecord({ form, mobileRecord, setMobileRecord, apiStatus, load, kind, setKind, setCategoryId, amount, setAmount, selectedAccount, currency, accounts, accountId, changeAccount, categories, categoryId, recordDate, setRecordDate, notes, setNotes, busy, submit, openForm }: FinanceHook) {
  if (form !== null && form !== 'transaction') return null
  return <form className={`actual-panel actual-record ${mobileRecord ? 'actual-record-open' : ''}`} onSubmit={submit}>
    <div className="actual-record-title"><h2>Record</h2><ApiStatusPill status={apiStatus} /><button type="button" className="actual-refresh" aria-label="Refresh" title="Refresh" onClick={() => void load()}>Refresh</button><button type="button" className="actual-record-close" onClick={() => setMobileRecord(false)} aria-label="Close record">×</button></div>
    <div className="actual-record-types" role="radiogroup" aria-label="Transaction type">{(['expense', 'income'] as const).map((type) => <button type="button" role="radio" aria-checked={kind === type} key={type} onClick={() => { setKind(type); setCategoryId('') }}>{type === 'expense' ? <ArrowUpRight size={16} /> : <ArrowDownLeft size={16} />}{type === 'expense' ? 'Expense' : 'Income'}</button>)}</div>
    <label><span className="actual-label">Amount</span><span className="actual-amount"><input required aria-label="Amount (decimal)" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00"/><span>{symbolOf(selectedAccount?.currency ?? currency)}</span></span></label>
    <div className="actual-record-fields"><label><span className="actual-label">Account</span><select aria-label="Account" required value={accountId} onChange={(event) => changeAccount(event.target.value)}><option value="">Choose account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></label><label><span className="actual-label">Category</span><select aria-label="Category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Uncategorized</option>{categories.filter((item) => item.kind === kind).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span className="actual-label">Date</span><input required type="date" value={recordDate} onChange={(event) => setRecordDate(event.target.value)}/></label><label><span className="actual-label">Note</span><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional"/></label></div>
    <div className="actual-record-mobile-choices"><span>Account</span><div>{accounts.map((item) => <button key={item.id} type="button" aria-pressed={accountId === item.id} onClick={() => changeAccount(item.id)}>{item.name}</button>)}</div><span>Category</span><div><button type="button" aria-pressed={!categoryId} onClick={() => setCategoryId('')}>Uncategorized</button>{categories.filter((item) => item.kind === kind).map((item) => <button key={item.id} type="button" aria-pressed={categoryId === item.id} onClick={() => setCategoryId(item.id)}>{item.name}</button>)}</div></div>
    <div className="actual-preview"><Info size={14} />{kind === 'expense' ? 'From' : 'Into'} {selectedAccount ? `${selectedAccount.name} · ${selectedAccount.currency}` : 'choose an account'} · {categories.find((item) => item.id === categoryId)?.name ?? 'Uncategorized'}</div>
    <button className="button button--primary actual-record-submit" disabled={busy || apiStatus !== 'ready' || !accountId}>{busy ? 'Saving…' : `Record ${kind}`}</button>
    <button type="button" className="actual-transfer-link" disabled={busy} onClick={() => openForm('transfer')}>Transfer between accounts</button>
  </form>
}

export function FinanceForm({ form, setForm, name, setName, kind, setKind, setCategoryId, categories, categoryId, accounts, accountId, changeAccount, toAccountId, setToAccountId, selectedAccount, currency, setCurrency, amount, setAmount, periodStart, setPeriodStart, periodEnd, setPeriodEnd, notes, setNotes, busy, apiStatus, submit }: FinanceHook) {
  if (!form || form === 'transaction') return null
  return <form className="connected-card settings-form" onSubmit={submit}>
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
  </form>
}

export function FinanceSummary({ summary, transactions, spendingCurrencies, categories }: FinanceHook) {
  return <section className="actual-panel actual-summary"><h2>Summary</h2><p className="actual-summary-sub">{summary?.count ?? 0} transactions</p>{summary?.currencies?.length ? summary.currencies.map((item) => <div className="actual-summary-currency" key={item.currency}><strong>{item.currency}</strong><b className={decimalToUnits(item.balance) < 0n ? 'is-negative' : decimalToUnits(item.balance) > 0n ? 'is-positive' : ''}>{displayMoney(decimalToUnits(item.balance), item.currency, 'always')}</b><span>Income <em className="is-income">{displayMoney(decimalToUnits(item.income), item.currency)}</em></span><span>Spent <em>{displayMoney(decimalToUnits(item.expense) < 0n ? -decimalToUnits(item.expense) : decimalToUnits(item.expense), item.currency)}</em></span></div>) : <p>No currency balances yet.</p>}{spendingCurrencies.map((currencyCode) => {
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
    return <div className="actual-finance-breakdown" key={currencyCode}><h3>{currencyCode} spending by category · {displayMoney(total, currencyCode)}</h3><div className="actual-finance-bar" aria-hidden="true">{segments.map((item) => <span key={item.id} style={{ width: `${item.percent}%`, background: item.color }} />)}</div><ul>{segments.map((item) => <li key={item.id}><i style={{ background: item.color }}/><span>{item.id ? categories.find((category) => category.id === item.id)?.name ?? 'Unknown category' : 'Uncategorized'}</span><em>{Math.round(item.percent)}%</em><b>{displayMoney(item.value, currencyCode)}</b></li>)}</ul></div>
  })}</section>
}

export function FinanceBudgets({ budgets, transactions, categories }: FinanceHook) {
  return budgets.length > 0 ? <section className="actual-panel actual-finance-budgets"><h2>Budgets</h2>{budgets.map((budget) => {
    const spent = transactions.filter((item) => item.type === 'expense' && item.currency === budget.currency && (!budget.category_id || item.category_id === budget.category_id) && Date.parse(item.occurred_at) >= Date.parse(budget.period_start) && Date.parse(item.occurred_at) < Date.parse(budget.period_end)).reduce((sum, item) => sum + expenseUnits(item), 0n)
    const limit = decimalToUnits(budget.limit_amount)
    const progress = limit > 0n ? Number((spent >= limit ? limit : spent) * 10000n / limit) / 100 : 0
    return <div className="actual-finance-budget" key={budget.id}><div><strong>{budget.category_id ? categories.find((category) => category.id === budget.category_id)?.name ?? 'Unknown category' : 'All categories'}</strong><span>{formatMoney(spent)} / {formatMoney(limit)} {budget.currency}</span></div><div className="actual-finance-progress" role="progressbar" aria-label={`${budget.category_id ? categories.find((category) => category.id === budget.category_id)?.name ?? 'Unknown category' : 'All categories'} budget`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }}/></div><small>{new Date(budget.period_start).toLocaleDateString()} – {new Date(budget.period_end).toLocaleDateString()} (end exclusive)</small></div>
  })}</section> : null
}

export function FinanceTools({ openForm, busy, categories, budgets }: FinanceHook) {
  return <details className="actual-panel actual-finance-tools"><summary>Categories &amp; budgets</summary><div className="actual-actions"><button className="button button--quiet" disabled={busy} onClick={() => openForm('category')}>Add category</button><button className="button button--quiet" disabled={busy} onClick={() => openForm('budget')}>Add budget</button></div><h3>Categories</h3>{categories.length ? categories.map((item) => <p key={item.id}>{item.name} · {item.kind}</p>) : <p>No categories yet.</p>}<h3>Budgets</h3>{budgets.length ? budgets.map((item) => <p key={item.id}>{categories.find((category) => category.id === item.category_id)?.name ?? 'All categories'}: {item.limit_amount} {item.currency} · {new Date(item.period_start).toLocaleDateString()} – {new Date(item.period_end).toLocaleDateString()}</p>) : <p>No budgets yet.</p>}</details>
}

export function FinanceHistory({ historyType, setHistoryType, historyAccount, setHistoryAccount, accounts, history, historyGroups, transactions, categories, todayKey }: FinanceHook) {
  return <section className="actual-panel actual-history"><div className="actual-history-head"><h2>History</h2><div className="actual-filter" role="radiogroup" aria-label="Filter history by type">{(['all', 'expense', 'income'] as const).map((value) => <button type="button" role="radio" aria-checked={historyType === value} aria-pressed={historyType === value} key={value} onClick={() => setHistoryType(value)}>{value === 'all' ? 'All' : value === 'expense' ? 'Expenses' : 'Income'}</button>)}</div><select className="actual-history-select" aria-label="Filter by account" value={historyAccount} onChange={(event) => setHistoryAccount(event.target.value)}><option value="all">All accounts</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    {history.length ? historyGroups.map(([day, items]) => <div className="actual-history-group" key={day}><div className="actual-history-day"><span>{fmtDay(day, todayKey)}</span><small>{new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</small></div>{items.map((item) => { const category = categories.find((entry) => entry.id === item.category_id)?.name ?? 'Uncategorized'; const color = catColor(category); const value = decimalToUnits(item.amount); return <article className="actual-history-row" key={item.id}><span className="actual-icon" aria-hidden="true" style={{ color, background: `${color}1A` }}><Wallet size={16} /></span><div><strong>{item.notes || category}</strong><small>{category} · {accounts.find((account) => account.id === item.account_id)?.name ?? 'Unknown account'}</small></div><b className={item.type === 'income' ? 'is-income' : ''}>{displayMoney(item.type === 'income' ? (value < 0n ? -value : value) : (value > 0n ? -value : value), item.currency, 'always')}</b></article> })}</div>) : <p className="actual-empty">{transactions.length ? 'No transactions for these filters.' : 'No transactions yet.'}</p>}
  </section>
}
