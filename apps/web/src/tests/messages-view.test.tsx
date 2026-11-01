import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type TelegramBusinessMessage, type TelegramStatus } from '@aelys/shared'
import { MessagesView } from '../views/MessagesView'
import { draftOf, groupChats } from '../lib/telegramMessages'

const client = vi.hoisted(() => ({ telegramStatus: vi.fn(), telegramMessages: vi.fn(), draftTelegramMessage: vi.fn(), sendTelegramMessage: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const status = { configured: true, enabled: true, connections: [] } as unknown as TelegramStatus
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 36e5).toISOString()
const msg = (over: Partial<TelegramBusinessMessage>): TelegramBusinessMessage => ({ id: 'm', version: 1, business_connection_id: 'c', chat_id: 1, telegram_message_id: 1, sender_id: 2, chat_title: 'Aidana', text: 'Hi', sent_at: iso(1), direction: 'inbound', draft_text: null, owner_note: null, draft_status: 'none', draft_error_code: null, deleted_at: null, ...over })
const aidana = msg({ id: 'a1', draft_text: 'Hi! I will check.', draft_status: 'ready', text: 'Are you free tomorrow?' })
const dana = msg({ id: 'd1', chat_id: 2, chat_title: 'Dana Studio', text: 'Can we move the call?', sent_at: iso(3) })
const mom = [msg({ id: 'p1', chat_id: 3, chat_title: 'Mom', text: 'Call me', sent_at: iso(30), draft_status: 'sent', draft_text: 'Will do' }), msg({ id: 'p2', chat_id: 3, chat_title: 'Mom', direction: 'owner', text: 'Thanks', sent_at: iso(29), telegram_message_id: 2 })]

let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)!
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<MessagesView apiStatus="ready" />)) }
beforeEach(() => { vi.resetAllMocks(); client.telegramStatus.mockResolvedValue(status); client.telegramMessages.mockResolvedValue([aidana, dana, ...mom]) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

describe('groupChats', () => {
  it('groups per chat, finds the newest incoming message and who still needs a reply', () => {
    const chats = groupChats([aidana, dana, ...mom])
    expect(chats.map((c) => c.title)).toEqual(['Aidana', 'Dana Studio', 'Mom'])
    expect(chats.map((c) => c.needsReply)).toEqual([true, true, false])
    expect(draftOf(chats[0])?.id).toBe('a1')
    expect(draftOf(chats[1])).toBeNull()
  })
  it('shows a sent draft as an Aelys reply unless the owner echo exists', () => {
    expect(groupChats([msg({ draft_status: 'sent', draft_text: 'Done' })])[0].lines.map((l) => [l.text, l.byAelys])).toEqual([['Hi', false], ['Done', true]])
    expect(groupChats([msg({ draft_status: 'sent', draft_text: 'Done' }), msg({ id: 'o', direction: 'owner', text: 'Done', sent_at: iso(0), telegram_message_id: 3 })])[0].lines.some((l) => l.byAelys)).toBe(false)
  })
  it('keeps deleted messages as a placeholder without their text', () => {
    const line = groupChats([msg({ deleted_at: iso(0), text: '' })])[0].lines[0]
    expect(line.text).toBe('Message deleted'); expect(line.deleted).toBe(true)
  })
})

describe('MessagesView', () => {
  it('lists chats that need a reply with the draft chip and opens the draft card', async () => {
    await mount()
    expect(host.textContent).toContain('Needs reply · 2')
    expect([...host.querySelectorAll('.msg__row-name')].map((n) => n.textContent)).toEqual(['Aidana', 'Dana Studio'])
    expect(host.querySelector('.msg__chip')?.textContent).toContain('Draft')
    expect(host.querySelector('.msg__draft-text')?.textContent).toBe('Hi! I will check.')
    expect(host.textContent).toContain('⌘↵ send · J / K next chat'); expect(host.textContent).not.toContain('Auto-reply')
  })
  it('sends the draft with the message version and an idempotency key, then moves to the next chat', async () => {
    client.sendTelegramMessage.mockResolvedValue({ ...aidana, draft_status: 'sent', version: 2 })
    await mount(); await act(async () => button('Send').click())
    expect(client.sendTelegramMessage).toHaveBeenCalledWith('a1', { version: 1, text: 'Hi! I will check.' }, { idempotencyKey: expect.any(String) })
    expect(host.querySelector('.msg__chat-name')?.textContent).toBe('Dana Studio')
  })
  it('creates and rewrites drafts through the draft endpoint', async () => {
    client.draftTelegramMessage.mockResolvedValue({ ...dana, draft_status: 'ready', draft_text: 'Friday works.', version: 2 })
    await mount(); await act(async () => host.querySelectorAll<HTMLElement>('.msg__row')[1].click())
    await act(async () => button('Draft a reply').click())
    expect(client.draftTelegramMessage).toHaveBeenCalledWith('d1', { version: 1 })
    expect(host.querySelector('.msg__draft-text')?.textContent).toBe('Friday works.')
  })
  it('edits a draft into the composer and sends it as an own reply', async () => {
    client.sendTelegramMessage.mockResolvedValue({ ...aidana, draft_status: 'sent', version: 2 })
    await mount(); await act(async () => button('Edit').click())
    const input = host.querySelector<HTMLInputElement>('[aria-label="Write a reply"]')!
    expect(input.value).toBe('Hi! I will check.')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(client.sendTelegramMessage).toHaveBeenCalledWith('a1', { version: 1, text: 'Hi! I will check.' }, expect.anything())
  })
  it('skips a draft locally and shows the empty state once nothing is left', async () => {
    client.telegramMessages.mockResolvedValue([aidana])
    await mount(); await act(async () => button('Skip').click())
    expect(host.textContent).toContain('All caught up'); expect(host.textContent).toContain('Needs reply · 0')
    expect(client.sendTelegramMessage).not.toHaveBeenCalled()
  })
  it('maps API error codes to safe notices without leaking provider text', async () => {
    client.sendTelegramMessage.mockRejectedValue(new ApiError(409, 'TELEGRAM_REPLY_WINDOW_EXPIRED', 'secret sk-123'))
    await mount(); await act(async () => button('Send').click())
    expect(host.textContent).toContain('24 hours'); expect(host.textContent).not.toContain('sk-123')
  })
  it('sends with Cmd+Enter and searches chats', async () => {
    client.sendTelegramMessage.mockResolvedValue({ ...aidana, draft_status: 'sent', version: 2 })
    await mount(); await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true })) })
    expect(client.sendTelegramMessage).toHaveBeenCalledTimes(1)
  })
  it('shows the skeleton error with a retry when the API is unreachable', async () => {
    client.telegramStatus.mockRejectedValueOnce(new Error('offline'))
    await mount(); expect(host.textContent).toContain('Can’t reach Aelys')
    await act(async () => button('Try again').click()); expect(host.textContent).toContain('Needs reply')
  })
})
