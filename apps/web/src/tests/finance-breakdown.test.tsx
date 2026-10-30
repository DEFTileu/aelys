import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decimalToUnits, formatMoney, sumDecimals } from '../lib/money'
import { FinanceView } from '../views/FinanceView'

const client = vi.hoisted(() => ({ financeAccounts: vi.fn(), financeCategories: vi.fn(), financeBudgets: vi.fn(), financeTransactions: vi.fn(), financeSummary: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

describe('exact finance amounts', () => {
  it('sums signed large amounts and preserves four decimal places', () => {
    expect(formatMoney(sumDecimals(['9999999999999999.9999', '0.0001', '-0.1200']))).toBe('9999999999999999.88')
    expect(formatMoney(decimalToUnits('-1234567890123456.0001'))).toBe('-1234567890123456.0001')
    expect(() => decimalToUnits('1.00001')).toThrow()
  })
})

describe('finance ledger presentation', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { if (root) act(() => root?.unmount()); document.body.innerHTML = '' })
  it('uses signed postings for account balances and excludes transfers and other currencies from spending and budgets', async () => {
    client.financeAccounts.mockResolvedValue([{ id: 'a', name: 'Card', currency: 'KZT', type: 'card' }, { id: 'b', name: 'Cash', currency: 'KZT', type: 'cash' }, { id: 'c', name: 'Dollar', currency: 'USD', type: 'cash' }])
    client.financeCategories.mockResolvedValue([{ id: 'food', name: 'Food', kind: 'expense' }])
    client.financeBudgets.mockResolvedValue([{ id: 'budget', category_id: 'food', currency: 'KZT', period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z', limit_amount: '2000000000000000.0002' }])
    client.financeSummary.mockResolvedValue({ count: 6, currencies: [] })
    const transaction = (id: string, account_id: string, type: string, amount: string, currency: string, category_id: string | null, occurred_at = '2026-10-10T00:00:00Z') => ({ id, account_id, type, amount, currency, category_id, occurred_at, notes: '' })
    client.financeTransactions.mockResolvedValue([
      transaction('1', 'a', 'income', '2000000000000000.0002', 'KZT', null),
      transaction('2', 'a', 'expense', '-1000000000000000.0001', 'KZT', 'food'),
      transaction('3', 'a', 'transfer', '-10.0001', 'KZT', null),
      transaction('4', 'b', 'transfer', '10.0001', 'KZT', null),
      transaction('5', 'c', 'expense', '-2.0001', 'USD', null),
      transaction('6', 'a', 'expense', '-3.0001', 'KZT', 'food', '2026-11-01T00:00:00Z'),
    ])
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => root!.render(<FinanceView apiStatus="ready" />))
    const cards = host.querySelectorAll('.actual-account')
    expect(cards[0]!.textContent).toContain('999999999999986.9999 KZT')
    expect(cards[1]!.textContent).toContain('10.0001 KZT')
    const breakdowns = host.querySelectorAll('.actual-finance-breakdown')
    expect(breakdowns).toHaveLength(2)
    expect(breakdowns[0]!.textContent).toContain('1000000000000003.0002')
    expect(breakdowns[1]!.textContent).toContain('2.0001')
    expect(host.querySelector('.actual-finance-budget')!.textContent).toContain('1000000000000000.0001 / 2000000000000000.0002 KZT')
    expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('50')
  })
})
