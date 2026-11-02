import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FinanceView } from '../views/FinanceView'

const client = vi.hoisted(() => ({ financeAccounts: vi.fn(), financeCategories: vi.fn(), financeBudgets: vi.fn(), financeTransactions: vi.fn(), financeSummary: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', media: query, addEventListener() {}, removeEventListener() {} }))
  client.financeAccounts.mockResolvedValue([{ id: 'a1', name: 'Cash', currency: 'KZT', type: 'cash' }])
  client.financeCategories.mockResolvedValue([{ id: 'food', name: 'Food', kind: 'expense' }])
  client.financeBudgets.mockResolvedValue([]); client.financeTransactions.mockResolvedValue([]); client.financeSummary.mockResolvedValue({ count: 0, total: '0', currencies: [] })
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<FinanceView apiStatus="ready" />))
}

it('renders the mobile balance, accounts and history without the desktop columns', async () => {
  await mount()
  expect(host.querySelector('.finance-m')).not.toBeNull()
  expect(host.querySelector('.actual-finance-columns')).toBeNull()
  expect(host.querySelector('.actual-finance-mobile-total')).not.toBeNull()
  expect(host.querySelectorAll('.actual-account')).toHaveLength(1)
  expect(host.querySelector('.actual-history')).not.toBeNull()
})

it('opens the record sheet from the FAB and hides the FAB while it is open', async () => {
  await mount()
  await act(async () => host.querySelector<HTMLButtonElement>('button.finance-m-fab')!.click())
  expect(host.querySelector('.actual-record.actual-record-open')).not.toBeNull()
  expect(host.querySelector('button.finance-m-fab')).toBeNull()
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!.value).toBe('a1')
})
