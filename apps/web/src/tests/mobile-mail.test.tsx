import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MailView } from '../views/MailView'

const client = vi.hoisted(() => ({ mailMessages: vi.fn(), mailDrafts: vi.fn(), mailAccounts: vi.fn(), gmailStatus: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', media: query, addEventListener() {}, removeEventListener() {} }))
  window.history.replaceState({}, '', '/mail')
  client.mailMessages.mockResolvedValue([{ id: 'm1', sender: 'Person <person@example.test>', recipients: ['owner@example.test'], subject: 'Question', body: 'Hello there', received_at: '2026-10-29T12:00:00Z', thread_id: null, is_read: false }])
  client.mailDrafts.mockResolvedValue([]); client.mailAccounts.mockResolvedValue([]); client.gmailStatus.mockResolvedValue({ configured: false })
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<MailView apiStatus="ready" />))
}

it('renders the mobile list screen with a Compose FAB and no desktop grid', async () => {
  await mount()
  expect(host.querySelector('.mail-m')).not.toBeNull()
  expect(host.querySelector('.actual-mail-grid')).toBeNull()
  expect(host.querySelectorAll('.actual-mail-row')).toHaveLength(1)
  expect(host.querySelector('button.mail-m-fab[aria-label="Compose"]')).not.toBeNull()
})

it('opens the reader from a row and returns to the list with Back', async () => {
  await mount()
  await act(async () => host.querySelector<HTMLButtonElement>('.actual-mail-row')!.click())
  expect(host.querySelector('.mail-m-fab')).toBeNull()
  expect(host.querySelector('.actual-mail-reader article h2')!.textContent).toBe('Question')
  await act(async () => host.querySelector<HTMLButtonElement>('.actual-back')!.click())
  expect(host.querySelector('.mail-m-fab')).not.toBeNull()
})

it('opens a new draft from the FAB on the reader screen', async () => {
  await mount()
  await act(async () => host.querySelector<HTMLButtonElement>('.mail-m-fab')!.click())
  expect(host.querySelector('textarea[aria-label="Draft message"]')).not.toBeNull()
  expect(host.querySelector('.actual-mail-list')).toBeNull()
})
