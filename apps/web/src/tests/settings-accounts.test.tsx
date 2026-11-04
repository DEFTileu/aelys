import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { AccountsPanel } from '../views/settings/AccountsPanel'

const client = vi.hoisted(() => ({ mailAccounts: vi.fn(), gmailStatus: vi.fn(), telegramStatus: vi.fn(), disconnectGmail: vi.fn(), disconnectTelegram: vi.fn(), clearReadCache: vi.fn() }))
const connect = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client, connectGmailAccount: connect }))

let root: ReturnType<typeof createRoot>
beforeEach(() => { vi.resetAllMocks(); client.mailAccounts.mockResolvedValue([]); client.gmailStatus.mockResolvedValue({ configured: true }); client.telegramStatus.mockResolvedValue({ configured: false }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('Connected accounts', () => {
  it('lists Gmail and Telegram with status and Disconnect', async () => {
    client.mailAccounts.mockResolvedValue([{ id: 'g1', provider: 'gmail', external_id: 'me@example.com', connection_status: 'connected' }])
    client.gmailStatus.mockResolvedValue({ configured: true })
    client.telegramStatus.mockResolvedValue({ configured: true, enabled: true, bot_username: 'aelys_bot' })
    client.disconnectGmail.mockResolvedValue({ provider_revoked: true }); client.disconnectTelegram.mockResolvedValue({ disconnected: true })
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => root.render(<AccountsPanel apiStatus="ready" onGo={() => {}} />))
    expect(host.textContent).toContain('me@example.com'); expect(host.textContent).toContain('@aelys_bot')
    const buttons = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Disconnect')
    expect(buttons).toHaveLength(2)
    await act(async () => buttons[0]!.click()); expect(client.disconnectGmail).toHaveBeenCalledWith('g1')
    await act(async () => buttons[1]!.click()); expect(client.disconnectTelegram).toHaveBeenCalled()
  })
})


it('keeps Gmail connection unavailable when the Google client is missing', async () => {
  client.gmailStatus.mockResolvedValue({ configured: false })
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<AccountsPanel apiStatus="ready" onGo={() => {}} />))
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Connect Gmail')!
  expect(button.disabled).toBe(true)
  expect(host.textContent).toContain('server setup')
  expect(connect).not.toHaveBeenCalled()
})

it.each([false, true])('uses the browser bridge and revalidates the account on return (reconnect=%s)', async (reconnect) => {
  const account = { id: 'g1', version: 1, provider: 'gmail', external_id: 'me@example.com', connection_status: 'connected' }
  client.mailAccounts.mockResolvedValue(reconnect ? [account] : [])
  connect.mockResolvedValue(undefined)
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<AccountsPanel apiStatus="ready" onGo={() => {}} />))
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Connect Gmail')!
  await act(async () => button.click())
  expect(connect).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Complete the Google connection in your browser')
  client.mailAccounts.mockResolvedValue([{ ...account, version: reconnect ? 2 : 1 }])
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(client.mailAccounts).toHaveBeenLastCalledWith({ forceRefresh: true, allowCacheFallback: false })
  expect(client.clearReadCache).toHaveBeenCalled()
  expect(host.textContent).toContain('Gmail connected.')
  expect(host.textContent).toContain('me@example.com')
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Load latest')).toBe(true)
})


it('clears account details when returning to a rejected session', async () => {
  const account = { id: 'g1', version: 1, provider: 'gmail', external_id: 'private@example.com', connection_status: 'connected' }
  client.mailAccounts.mockResolvedValue([account]); connect.mockResolvedValue(undefined)
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<AccountsPanel apiStatus="ready" onGo={() => {}} />))
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Connect Gmail')!.click())
  client.mailAccounts.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Sign in again.'))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(host.textContent).not.toContain('private@example.com')
  expect(host.textContent).toContain('Sign in again.')
})
