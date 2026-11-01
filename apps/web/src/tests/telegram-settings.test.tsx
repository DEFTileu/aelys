import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, type TelegramBusinessMessage, type TelegramStatus } from '@aelys/shared'
import { TelegramSettings } from '../views/TelegramSettings'

const client = vi.hoisted(() => ({ telegramStatus: vi.fn(), telegramMessages: vi.fn(), aiProviders: vi.fn(), connectTelegram: vi.fn(), telegramBinding: vi.fn(), updateTelegramSettings: vi.fn(), disconnectTelegram: vi.fn(), syncTelegram: vi.fn(), draftTelegramMessage: vi.fn(), sendTelegramMessage: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const status: TelegramStatus = { configured: true, id: 'bot', version: 3, bot_username: 'example_bot', bot_name: 'Example', business_capable: true, enabled: true, auto_reply: false, owner_telegram_id: null, provider_id: null, model: null, instructions: '', last_polled_at: null, last_error_code: null, connections: [], timezone: 'UTC', digest_time: null, reply_delay_seconds: 90, status_text: null, status_until: null }
const message: TelegramBusinessMessage = { id: 'm1', version: 4, business_connection_id: 'c1', chat_id: 5, telegram_message_id: 6, sender_id: 7, chat_title: 'Клиент', text: '<script>test</script>', sent_at: '2026-10-29', direction: 'inbound', owner_note: null, draft_text: null, draft_status: 'none', draft_error_code: null, deleted_at: null }
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks(); client.telegramStatus.mockResolvedValue(status); client.telegramMessages.mockResolvedValue([]); client.aiProviders.mockResolvedValue([]) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })
async function mount() { const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<TelegramSettings />)); return host }
async function click(host: HTMLElement, text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text))!.click()) }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }

describe('Telegram settings', () => {
  it('saves timezone, optional digest and delay and reloads persisted settings', async () => {
    const next = { ...status, version: 4, timezone: 'Asia/Almaty', digest_time: '20:00', reply_delay_seconds: 120, status_text: 'Занят', status_until: '2026-11-02T13:00:00Z' }
    client.updateTelegramSettings.mockResolvedValue(next)
    const host = await mount()
    const field = (name: string) => [...host.querySelectorAll('input')].find(item => item.closest('label')?.textContent?.includes(name))!
    await input(field('Часовой пояс'), 'Asia/Almaty')
    await input(field('Время сводки'), '20:00')
    await input(field('Задержка ответа'), '120')
    await click(host, 'Сохранить личные настройки')
    expect(client.updateTelegramSettings).toHaveBeenCalledWith({ version: 3, timezone: 'Asia/Almaty', digest_time: '20:00', reply_delay_seconds: 120 })
    client.telegramStatus.mockResolvedValue(next)
    await act(async () => root!.unmount()); root = undefined; host.remove()
    const reloaded = await mount()
    expect(reloaded.querySelector<HTMLInputElement>('input[value="Asia/Almaty"]')).not.toBeNull()
    expect(reloaded.textContent).toContain('Занят')
  })
  it.each(['handoff', 'no_reply'])('shows %s without customer reply actions', async draft_status => {
    client.telegramMessages.mockResolvedValue([{ ...message, draft_status, owner_note: draft_status === 'handoff' ? 'Owner only note' : null }])
    const host = await mount()
    const conversation = [...host.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent?.includes('Клиент'))!
    expect(conversation.textContent).toContain(draft_status)
    expect(conversation.querySelector('textarea')).toBeNull()
    expect(conversation.querySelector('button')).toBeNull()
    if (draft_status === 'handoff') expect(conversation.textContent).toContain('Owner only note')
  })
  it('shows owner messages as history without draft or send controls', async () => {
    client.telegramMessages.mockResolvedValue([{ ...message, direction: 'owner' }])
    const host = await mount()
    const conversation = [...host.querySelectorAll('details')].find((item) => item.querySelector('summary')?.textContent?.includes('Клиент'))!
    expect(conversation.textContent).toContain(message.text)
    expect(conversation.textContent).toContain('Ваше исходящее сообщение')
    expect(conversation.querySelector('textarea')).toBeNull()
    expect(conversation.querySelector('button')).toBeNull()
    expect(client.draftTelegramMessage).not.toHaveBeenCalled()
    expect(client.sendTelegramMessage).not.toHaveBeenCalled()
  })
  it.each([
    [409, 'TELEGRAM_MESSAGE_UNAVAILABLE', 'Ответ доступен только для входящего сообщения'],
    [403, 'TELEGRAM_REPLY_DENIED', 'разрешение на ответы в настройках Telegram Business'],
    [403, 'TELEGRAM_REPLY_WINDOW_EXPIRED', 'Окно ответа Telegram (24 часа) истекло'],
  ])('explains HTTP %s %s without displaying provider error content', async (status, code, expected) => {
    client.telegramMessages.mockResolvedValue([{ ...message, draft_text: 'Ответ' }])
    client.sendTelegramMessage.mockRejectedValue(new ApiError(status, code, 'private-provider-content'))
    const host = await mount()
    await click(host, 'Отправить ответ')
    expect(host.querySelector('[role=status]')?.textContent).toContain(expected)
    expect(host.textContent).not.toContain('private-provider-content')
  })
  it('clears the write-only token on success and distinguishes a pending business connection', async () => {
    client.connectTelegram.mockResolvedValue(status)
    const host = await mount()
    expect(host.textContent).toContain('подключение Telegram Business ожидается')
    const field = host.querySelector<HTMLInputElement>('input[type=password]')!
    await input(field, 'secret-token')
    await act(async () => field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(client.connectTelegram).toHaveBeenCalledWith({ bot_token: 'secret-token' })
    expect(field.value).toBe('')
    expect(host.textContent).not.toContain('secret-token')
    expect(JSON.stringify(localStorage)).not.toContain('secret-token')
    expect(JSON.stringify(sessionStorage)).not.toContain('secret-token')
  })
  it('refreshes messages and status while keeping edited drafts and settings', async () => {
    vi.useFakeTimers()
    try {
      client.telegramMessages.mockResolvedValue([message])
      const host = await mount()
      const response = [...host.querySelectorAll('textarea')].find((item) => item.closest('label')?.textContent?.includes('Текст ответа'))!
      await input(response, 'Мой ответ')
      const persona = [...host.querySelectorAll('textarea')].find((item) => item.closest('label')?.textContent?.includes('Инструкции'))!
      await input(persona, 'Мои инструкции')
      client.telegramStatus.mockResolvedValue({ ...status, version: 4, instructions: 'Старые инструкции' })
      client.telegramMessages.mockResolvedValue([{ ...message, version: 5, draft_status: 'ready', draft_text: 'Новый черновик' }])
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(client.telegramStatus).toHaveBeenCalledTimes(2)
      expect(client.telegramMessages).toHaveBeenCalledTimes(2)
      expect(response.value).toBe('Мой ответ'); expect(persona.value).toBe('Мои инструкции')
      expect(host.textContent).toContain('ready')
      expect(client.syncTelegram).not.toHaveBeenCalled(); expect(client.sendTelegramMessage).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('updates settings using the returned version and leaves auto reply off by default', async () => {
    client.updateTelegramSettings.mockResolvedValue({ ...status, version: 4, auto_reply: true, provider_id: 'provider-1', model: 'model-a', instructions: 'Будь вежлив' })
    client.aiProviders.mockResolvedValue([{ id: 'provider-1', kind: 'claude', enabled: true, has_secret: true }])
    const host = await mount(); const select = host.querySelector<HTMLButtonElement>('[role=combobox]')!
    await act(async () => select.click())
    await act(async () => document.querySelector<HTMLElement>('[role=option][id$="option-1"]')!.click())
    const model = [...host.querySelectorAll('input')].find((item) => item.closest('label')?.textContent?.includes('Модель'))!
    await input(model, 'model-a')
    const persona = [...host.querySelectorAll('textarea')].find((item) => item.closest('label')?.textContent?.includes('Инструкции'))!
    await input(persona, 'Будь вежлив')
    const check = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    expect(host.textContent).toContain('Читать и отвечать автоматически')
    expect(host.textContent).toContain('автоматически отвечает от вашего имени')
    expect(host.textContent).toContain('API-ключом')
    expect(check.checked).toBe(false)
    await act(async () => check.click())
    expect(client.updateTelegramSettings).toHaveBeenCalledWith({ version: 3, auto_reply: true, provider_id: 'provider-1', model: 'model-a', instructions: 'Будь вежлив' })
    expect(check.checked).toBe(true)
  })
  it('keeps setup and message details collapsed until requested', async () => {
    client.telegramMessages.mockResolvedValue([message])
    const host = await mount()
    const disclosures = [...host.querySelectorAll('details')]
    const setup = disclosures.find((item) => item.querySelector('summary')?.textContent?.includes('Как подключить'))!
    const conversation = disclosures.find((item) => item.querySelector('summary')?.textContent?.includes('Клиент'))!
    expect(setup.open).toBe(false); expect(conversation.open).toBe(false)
    await act(async () => conversation.querySelector('summary')!.click())
    expect(conversation.open).toBe(true)
    expect(client.sendTelegramMessage).not.toHaveBeenCalled()
  })
  it('creates a draft and sends edited text only on explicit clicks, retaining the retry key', async () => {
    client.telegramMessages.mockResolvedValue([message])
    client.draftTelegramMessage.mockResolvedValue({ ...message, version: 5, draft_text: 'Ответ', draft_status: 'ready' })
    client.sendTelegramMessage.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ ...message, version: 6, draft_text: 'Исправленный ответ', draft_status: 'sent' })
    const host = await mount()
    expect(client.syncTelegram).not.toHaveBeenCalled(); expect(client.draftTelegramMessage).not.toHaveBeenCalled(); expect(client.sendTelegramMessage).not.toHaveBeenCalled()
    expect(host.querySelector('script')).toBeNull(); expect(host.textContent).toContain('<script>test</script>')
    await click(host, 'Создать черновик')
    expect(client.draftTelegramMessage).toHaveBeenCalledWith('m1', { version: 4 })
    const response = [...host.querySelectorAll('textarea')].find((item) => item.value === 'Ответ')!
    await input(response, 'Исправленный ответ')
    await click(host, 'Отправить ответ'); await click(host, 'Отправить ответ')
    expect(client.sendTelegramMessage).toHaveBeenCalledTimes(2)
    const first = client.sendTelegramMessage.mock.calls[0]; const second = client.sendTelegramMessage.mock.calls[1]
    expect(first[0]).toBe('m1'); expect(first[1]).toEqual({ version: 5, text: 'Исправленный ответ' })
    expect(first[2].idempotencyKey).toBeTruthy(); expect(second[2].idempotencyKey).toBe(first[2].idempotencyKey)
  })
})


describe('Telegram shared client', () => {
  it('uses the typed endpoints, versioned payloads and caller idempotency key', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    const api = new ApiClient({ baseUrl: 'https://aelys.test', fetch: fetcher as typeof fetch })
    await api.telegramStatus(); await api.connectTelegram({ bot_token: 'token' }); await api.telegramBinding()
    await api.updateTelegramSettings({ version: 8, auto_reply: false, timezone: 'Asia/Almaty', digest_time: null, reply_delay_seconds: 120 }); await api.disconnectTelegram(); await api.syncTelegram()
    await api.telegramMessages(); await api.draftTelegramMessage('m/1', { version: 9 })
    await api.sendTelegramMessage('m/1', { version: 10, text: 'hello' }, { idempotencyKey: 'retry-key' })
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url]) => url.replace('https://aelys.test/api/v1/integrations/telegram', ''))).toEqual(['/status', '/connect', '/binding', '/settings', '/disconnect', '/sync', '/messages', '/messages/m%2F1/draft', '/messages/m%2F1/send'])
    expect(calls[3][1].method).toBe('PATCH'); expect(JSON.parse(String(calls[3][1].body))).toEqual({ version: 8, auto_reply: false, timezone: 'Asia/Almaty', digest_time: null, reply_delay_seconds: 120 })
    expect(calls[8][1].headers).toMatchObject({ 'Idempotency-Key': 'retry-key' })
    expect(JSON.parse(String(calls[8][1].body))).toEqual({ version: 10, text: 'hello' })
  })
})
