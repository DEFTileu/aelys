import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, type TelegramBusinessMessage, type TelegramStatus } from '@aelys/shared'
import { TelegramSettings } from '../views/TelegramSettings'

const client = vi.hoisted(() => ({ telegramStatus: vi.fn(), telegramMessages: vi.fn(), aiProviders: vi.fn(), connectTelegram: vi.fn(), telegramBinding: vi.fn(), updateTelegramSettings: vi.fn(), disconnectTelegram: vi.fn(), syncTelegram: vi.fn(), draftTelegramMessage: vi.fn(), sendTelegramMessage: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const status: TelegramStatus = { configured: true, id: 'bot', version: 3, bot_username: 'example_bot', bot_name: 'Example', business_capable: true, enabled: true, auto_reply: false, owner_telegram_id: null, provider_id: null, model: null, instructions: '', last_polled_at: null, last_error_code: null, connections: [], timezone: 'UTC', digest_time: null, reply_delay_seconds: 90, deadline_reminders: false, quiet_start: null, quiet_end: null, status_text: null, status_until: null }
const message: TelegramBusinessMessage = { id: 'm1', version: 4, business_connection_id: 'c1', chat_id: 5, telegram_message_id: 6, sender_id: 7, chat_title: 'Customer', text: '<script>test</script>', sent_at: '2026-10-29', direction: 'inbound', owner_note: null, draft_text: null, draft_status: 'none', draft_error_code: null, deleted_at: null }
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks(); client.telegramStatus.mockResolvedValue(status); client.telegramMessages.mockResolvedValue([]); client.aiProviders.mockResolvedValue([]) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })
async function mount() { const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<TelegramSettings />)); return host }
async function click(host: HTMLElement, text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text))!.click()) }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }

describe('Telegram settings', () => {
  it('saves timezone, optional digest and delay and reloads persisted settings', async () => {
    const next = { ...status, version: 4, timezone: 'Asia/Almaty', digest_time: '20:00', reply_delay_seconds: 120, status_text: 'Busy', status_until: '2026-11-02T13:00:00Z' }
    client.updateTelegramSettings.mockResolvedValue(next)
    const host = await mount()
    const field = (name: string) => [...host.querySelectorAll('input')].find(item => item.closest('label')?.textContent?.includes(name))!
    await input(field('Time zone'), 'Asia/Almaty')
    await input(field('Digest time'), '20:00')
    await input(field('Reply delay'), '120')
    await click(host, 'Save personal settings')
    expect(client.updateTelegramSettings).toHaveBeenCalledWith({ version: 3, timezone: 'Asia/Almaty', digest_time: '20:00', reply_delay_seconds: 120, deadline_reminders: false, quiet_start: null, quiet_end: null })
    client.telegramStatus.mockResolvedValue(next)
    await act(async () => root!.unmount()); root = undefined; host.remove()
    const reloaded = await mount()
    expect(reloaded.querySelector<HTMLInputElement>('input[value="Asia/Almaty"]')).not.toBeNull()
    expect(reloaded.textContent).toContain('Busy')
  })
  it('keeps deadline reminders off by default and persists reminder and quiet-hour settings', async () => {
    const next = { ...status, version: 4, deadline_reminders: true, quiet_start: '22:00', quiet_end: '07:00' }
    client.updateTelegramSettings.mockResolvedValue(next)
    const host = await mount()
    const deadline = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(item => item.closest('label')?.textContent?.includes('Deadline reminders'))
    expect(deadline).toBeDefined()
    expect(deadline!.checked).toBe(false)
    const field = (name: string) => [...host.querySelectorAll('input')].find(item => item.closest('label')?.textContent?.includes(name))!
    expect(field('Quiet hours start').value).toBe('')
    expect(field('Quiet hours end').value).toBe('')
    await act(async () => deadline!.click())
    await input(field('Quiet hours start'), '22:00')
    await input(field('Quiet hours end'), '07:00')
    expect(client.updateTelegramSettings).not.toHaveBeenCalled()
    await click(host, 'Save personal settings')
    expect(client.updateTelegramSettings).toHaveBeenCalledWith({
      version: 3, timezone: 'UTC', digest_time: null, reply_delay_seconds: 90,
      deadline_reminders: true, quiet_start: '22:00', quiet_end: '07:00',
    })
    client.telegramStatus.mockResolvedValue(next)
    await act(async () => root!.unmount()); root = undefined; host.remove()
    const reloaded = await mount()
    expect([...reloaded.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(item => item.closest('label')?.textContent?.includes('Deadline reminders'))!.checked).toBe(true)
    expect(reloaded.querySelector<HTMLInputElement>('input[value="22:00"]')).not.toBeNull()
    expect(reloaded.querySelector<HTMLInputElement>('input[value="07:00"]')).not.toBeNull()
  })
  it('disables deadline reminders and clears both quiet-hour values with nulls', async () => {
    client.telegramStatus.mockResolvedValue({ ...status, deadline_reminders: true, quiet_start: '22:00', quiet_end: '07:00' })
    client.updateTelegramSettings.mockResolvedValue({ ...status, version: 4, deadline_reminders: false, quiet_start: null, quiet_end: null })
    const host = await mount()
    const deadline = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(item => item.closest('label')?.textContent?.includes('Deadline reminders'))
    expect(deadline).toBeDefined()
    expect(deadline!.checked).toBe(true)
    await act(async () => deadline!.click())
    const fields = [...host.querySelectorAll<HTMLInputElement>('input[type=time]')].filter(item => item.closest('label')?.textContent?.includes('Quiet hours'))
    expect(fields).toHaveLength(2)
    for (const field of fields) await input(field, '')
    await click(host, 'Save personal settings')
    expect(client.updateTelegramSettings).toHaveBeenCalledWith({
      version: 3, timezone: 'UTC', digest_time: null, reply_delay_seconds: 90,
      deadline_reminders: false, quiet_start: null, quiet_end: null,
    })
    expect(deadline!.checked).toBe(false)
    expect(fields.map(field => field.value)).toEqual(['', ''])
  })
  it.each(['Quiet hours start', 'Quiet hours end'])('requires the quiet-hour pair when only %s is set', async name => {
    const host = await mount()
    const fields = [...host.querySelectorAll<HTMLInputElement>('input[type=time]')].filter(item => item.closest('label')?.textContent?.includes('Quiet hours'))
    expect(fields).toHaveLength(2)
    await input(fields.find(field => field.closest('label')?.textContent?.includes(name))!, '22:00')
    const missing = fields.find(field => field.value === '')!
    expect(missing.required).toBe(true)
    expect(missing.checkValidity()).toBe(false)
    await click(host, 'Save personal settings')
    expect(client.updateTelegramSettings).not.toHaveBeenCalled()
    await input(missing, '07:00')
    expect(missing.checkValidity()).toBe(true)
  })
  it('keeps setup details collapsed until requested', async () => {
    const host = await mount()
    await act(async () => root!.unmount()); root = undefined; host.remove()
    client.telegramStatus.mockResolvedValue({ ...status, configured: false, version: null })
    const fresh = await mount()
    expect([...fresh.querySelectorAll('details')].find((item) => item.querySelector('summary')?.textContent?.includes('How to connect'))!.open).toBe(false)
  })
})


describe('Telegram shared client', () => {
  it('uses the typed endpoints, versioned payloads and caller idempotency key', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    const api = new ApiClient({ baseUrl: 'https://aelys.test', fetch: fetcher as typeof fetch })
    await api.telegramStatus(); await api.connectTelegram({ bot_token: 'token' }); await api.telegramBinding()
    await api.updateTelegramSettings({ version: 8, auto_reply: false, timezone: 'Asia/Almaty', digest_time: null, reply_delay_seconds: 120, deadline_reminders: true, quiet_start: '22:00', quiet_end: '07:00' }); await api.disconnectTelegram(); await api.syncTelegram()
    await api.telegramMessages(); await api.draftTelegramMessage('m/1', { version: 9 })
    await api.sendTelegramMessage('m/1', { version: 10, text: 'hello' }, { idempotencyKey: 'retry-key' })
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url]) => url.replace('https://aelys.test/api/v1/integrations/telegram', ''))).toEqual(['/status', '/connect', '/binding', '/settings', '/disconnect', '/sync', '/messages', '/messages/m%2F1/draft', '/messages/m%2F1/send'])
    expect(calls[3][1].method).toBe('PATCH'); expect(JSON.parse(String(calls[3][1].body))).toEqual({ version: 8, auto_reply: false, timezone: 'Asia/Almaty', digest_time: null, reply_delay_seconds: 120, deadline_reminders: true, quiet_start: '22:00', quiet_end: '07:00' })
    expect(calls[8][1].headers).toMatchObject({ 'Idempotency-Key': 'retry-key' })
    expect(JSON.parse(String(calls[8][1].body))).toEqual({ version: 10, text: 'hello' })
  })
})
