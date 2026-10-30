import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from '../components/NotificationCenter'

const client = vi.hoisted(() => ({ notifications: vi.fn(), dispatchCalendarReminders: vi.fn(), markNotificationRead: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const today = { id: 'today', title: 'Today reminder', body: 'Meeting', read_at: null, created_at: new Date().toISOString() }
const earlier = { id: 'earlier', title: 'Earlier reminder', body: 'Task', read_at: null, created_at: '2020-01-01T12:00:00Z' }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function render(status: 'ready' | 'offline' = 'ready') { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<NotificationCenter apiStatus={status} route="/" />)) }
async function click(label: string) { const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label); expect(button).toBeTruthy(); await act(async () => button!.click()) }
beforeEach(() => { vi.resetAllMocks(); client.notifications.mockResolvedValue([today, earlier]); client.dispatchCalendarReminders.mockResolvedValue({ delivered: 0 }) })
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = '' })

describe('notification center', () => {
  it('interprets offset-free server timestamps as UTC before formatting', async () => {
    const record = { ...today, created_at: today.created_at.replace(/Z$/, '') }
    client.notifications.mockResolvedValue([record])
    const format = vi.spyOn(Date.prototype, 'toLocaleTimeString')
    try {
      await render(); await click('Notifications (1 unread)')
      expect(format.mock.contexts.some(date => date instanceof Date && date.getTime() === Date.parse(today.created_at))).toBe(true)
    } finally { format.mockRestore() }
  })
  it('groups real notifications, filters unread, and handles partial mark-all failures', async () => {
    client.markNotificationRead.mockImplementation(async (id: string) => { if (id === 'earlier') throw new Error('failed'); return { ...today, read_at: '2026-01-01T00:00:00Z' } })
    await render(); await click('Notifications (2 unread)')
    expect(host.querySelector('[role="dialog"]')).toBe(document.activeElement)
    expect(host.querySelector('[aria-label="Today"]')?.textContent).toContain('Today reminder')
    expect(host.querySelector('[aria-label="Earlier"]')?.textContent).toContain('Earlier reminder')
    await click('Mark all as read')
    expect(client.markNotificationRead).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Could not mark some notifications as read')
    expect(host.querySelector('.notification-center__trigger')?.getAttribute('aria-label')).toBe('Notifications (1 unread)')
    await click('Unread (1)')
    expect(host.textContent).not.toContain('Today reminder')
    expect(host.textContent).toContain('Earlier reminder')
  })
  it('closes on Escape and outside pointer and returns focus on Escape', async () => {
    await render(); await click('Notifications (2 unread)')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.notification-center__trigger'))
    await click('Notifications (2 unread)')
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
  it('shows cached data and disables writes offline', async () => {
    await render('offline'); await click('Notifications (2 unread)')
    expect(client.dispatchCalendarReminders).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Showing cached notifications')
    expect([...host.querySelectorAll('button')].find((node) => node.textContent === 'Mark all as read')?.disabled).toBe(true)
    expect(client.markNotificationRead).not.toHaveBeenCalled()
  })
})
