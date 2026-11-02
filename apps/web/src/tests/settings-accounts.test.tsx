import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountsPanel } from '../views/settings/AccountsPanel'

const client = vi.hoisted(() => ({ mailAccounts: vi.fn(), gmailStatus: vi.fn(), telegramStatus: vi.fn(), disconnectGmail: vi.fn(), disconnectTelegram: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = '' })

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
