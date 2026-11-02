import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TelegramBusinessMessage, TelegramStatus } from '@aelys/shared'
import { MessagesView } from '../views/MessagesView'

const client = vi.hoisted(() => ({ telegramStatus: vi.fn(), telegramMessages: vi.fn(), draftTelegramMessage: vi.fn(), sendTelegramMessage: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const status = { configured: true, enabled: true, connections: [] } as unknown as TelegramStatus
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 36e5).toISOString()
const msg = (over: Partial<TelegramBusinessMessage>): TelegramBusinessMessage => ({ id: 'm', version: 1, business_connection_id: 'c', chat_id: 1, telegram_message_id: 1, sender_id: 2, chat_title: 'Aidana', text: 'Hi', sent_at: iso(1), direction: 'inbound', draft_text: null, owner_note: null, draft_status: 'none', draft_error_code: null, deleted_at: null, ...over })
const aidana = msg({ id: 'a1', draft_text: 'Hi! I will check.', draft_status: 'ready', text: 'Are you free tomorrow?' })
const dana = msg({ id: 'd1', chat_id: 2, chat_title: 'Dana Studio', text: 'Can we move the call?', sent_at: iso(3) })

let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement
const byText = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)!
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<MessagesView apiStatus="ready" />)) }

beforeEach(() => {
  vi.resetAllMocks()
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query === '(max-width: 700px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
  client.telegramStatus.mockResolvedValue(status)
  client.telegramMessages.mockResolvedValue([aidana, dana])
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; delete (window as { matchMedia?: unknown }).matchMedia })

it('shows the chat list on phones and no desktop layout', async () => {
  await mount()
  expect(host.querySelector('.msg-m')).not.toBeNull()
  expect(host.querySelector('.msg')).toBeNull()
  expect([...host.querySelectorAll('.msg-m__row-name')].map((n) => n.textContent)).toEqual(['Aidana', 'Dana Studio'])
  expect(host.querySelector('.msg-m__chat')).toBeNull()
})

it('opens one conversation at a time with a pinned reply bar, and goes back to the list', async () => {
  await mount()
  await act(async () => host.querySelectorAll<HTMLElement>('.msg-m__row')[1].click())
  expect(host.querySelector('.msg-m__chat')?.getAttribute('aria-label')).toBe('Conversation with Dana Studio')
  expect(host.querySelector('.msg-m__dock [aria-label="Write a reply"]')).not.toBeNull()
  expect(host.querySelector('.msg-m__list')).toBeNull()
  await act(async () => host.querySelector<HTMLElement>('.msg-m__back')!.click())
  expect(host.querySelector('.msg-m__chat')).toBeNull()
  expect(host.querySelector('.msg-m__list')).not.toBeNull()
})

it('sends the draft from the chat and returns to the list', async () => {
  client.sendTelegramMessage.mockResolvedValue({ ...aidana, draft_status: 'sent', version: 2 })
  await mount()
  await act(async () => host.querySelectorAll<HTMLElement>('.msg-m__row')[0].click())
  await act(async () => byText('Send').click())
  expect(client.sendTelegramMessage).toHaveBeenCalledWith('a1', { version: 1, text: 'Hi! I will check.' }, { idempotencyKey: expect.any(String) })
  expect(host.querySelector('.msg-m__chat')).toBeNull()
})
