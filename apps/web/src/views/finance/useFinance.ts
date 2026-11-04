import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { FinanceAccount, FinanceBudget, FinanceCategory, FinanceSummary, FinanceTransaction } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { decimalToUnits, formatMoney, sumDecimals } from '../../lib/money'
import type { ApiStatus } from '../../types'

// Exact grouped display ("192 120.00 ₸", "$1 205.00"): integer and fraction digits come straight from the fixed-point value.
const SYMBOLS: Record<string, [string, 'before' | 'after']> = { KZT: ['\u20B8', 'after'], USD: ['$', 'before'], EUR: ['\u20AC', 'before'], RUB: ['\u20BD', 'after'] }
export function displayMoney(units: bigint, currency: string, sign: 'none' | 'always' = 'none'): string {
  const raw = formatMoney(units < 0n ? -units : units)
  const [whole, fraction] = raw.split('.')
  const grouped = `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${fraction}`
  const [symbol, side] = SYMBOLS[currency.toUpperCase()] ?? [currency.toUpperCase(), 'after']
  const text = side === 'before' ? `${symbol}${grouped}` : `${grouped} ${symbol}`
  const mark = units < 0n ? '\u2212 ' : sign === 'always' && units > 0n ? '+ ' : ''
  return `${mark}${text}`
}
export const symbolOf = (currency: string) => SYMBOLS[currency.toUpperCase()]?.[0] ?? currency.toUpperCase()
const CAT_COLORS = ['#D97706', '#2F6FE4', '#6A4CF2', '#E2553F', '#14966C', '#D9367E', '#0F9488']
export const catColor = (name: string) => CAT_COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % CAT_COLORS.length]!
const dayKeyOf = (iso: string) => { const date = new Date(iso); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
type FormKind = 'account' | 'category' | 'budget' | 'transaction' | 'transfer'
const decimal = (value: string) => /^\d{1,16}(\.\d{1,4})?$/.test(value) && /[1-9]/.test(value)
const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const first = new Date(); first.setDate(1)
const next = new Date(first); next.setMonth(next.getMonth() + 1)

export function useFinance(apiStatus: ApiStatus) {
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
  const load = useCallback(async (forceRefresh = true) => {
    try {
      const client = getSharedApiClient()
      const [loadedAccounts, loadedCategories, loadedBudgets, loadedTransactions, loadedSummary] = await Promise.all([client.financeAccounts({ forceRefresh }), client.financeCategories({ forceRefresh }), client.financeBudgets({ forceRefresh }), client.financeTransactions({ forceRefresh }), client.financeSummary({ forceRefresh })])
      setAccounts(loadedAccounts); setCategories(loadedCategories); setBudgets(loadedBudgets); setTransactions(loadedTransactions); setSummary(loadedSummary)
      setAccountId((id) => { const account = loadedAccounts.find((item) => item.id === id) ?? loadedAccounts[0]; if (account) setCurrency(account.currency); return account?.id ?? '' })
      setStatus('ready')
    } catch (error) {
      setStatus(navigator.onLine ? 'error' : 'offline')
      setNotice(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Finance unavailable. Check your connection and owner session.')
    }
  }, [])
  useEffect(() => { void load(false) }, [load, apiStatus])
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
  const todayKey = dayKeyOf(new Date().toISOString())
  const historyGroups = (() => {
    const groups = new Map<string, FinanceTransaction[]>()
    for (const item of [...transactions].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))) {
      if ((historyType !== 'all' && item.type !== historyType) || (historyAccount !== 'all' && item.account_id !== historyAccount)) continue
      const key = dayKeyOf(item.occurred_at)
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    return [...groups.entries()]
  })()
  const history = transactions.filter((item) => (historyType === 'all' || item.type === historyType) && (historyAccount === 'all' || item.account_id === historyAccount))
  return { accounts, categories, budgets, transactions, summary, name, setName, currency, setCurrency, categoryId, setCategoryId, kind, setKind, amount, setAmount, recordDate, setRecordDate, periodStart, setPeriodStart, periodEnd, setPeriodEnd, accountId, toAccountId, setToAccountId, notes, setNotes, form, setForm, busy, status, notice, mobileRecord, setMobileRecord, historyType, setHistoryType, historyAccount, setHistoryAccount, load, openForm, submit, selectedAccount, changeAccount, accountBalance, expenseUnits, spendingCurrencies, palette, todayKey, historyGroups, history }
}
