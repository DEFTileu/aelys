import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CalendarView } from '../views/CalendarView'

const client = vi.hoisted(() => ({ calendarOccurrences: vi.fn(), createCalendarEvent: vi.fn(), calendarReminders: vi.fn(), updateCalendarEvent: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

describe('calendar event creation', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.clearAllMocks() })

  it('sends the displayed start and end to the backend', async () => {
    client.calendarOccurrences.mockResolvedValue([])
    client.createCalendarEvent.mockResolvedValue({})
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root?.render(<CalendarView apiStatus="ready" />) })
    const create = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Create event'))!
    await act(async () => { create.click() })
    const title = host.querySelector<HTMLInputElement>('[aria-label="New event title"]')!
    const start = host.querySelector<HTMLInputElement>('[aria-label="Event start"]')!
    const end = host.querySelector<HTMLInputElement>('[aria-label="Event end"]')!
    const reminder = host.querySelector<HTMLInputElement>('[aria-label="Event reminder"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(start, '2026-10-29T23:00'); start.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(end, '2026-10-29T23:30'); end.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(reminder, '2026-10-29T22:00'); reminder.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { setValue.call(title, 'Planning'); title.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(start.value).toBe('2026-10-29T23:00')
    const expectedStart = new Date(start.value).toISOString()
    const expectedEnd = new Date(end.value).toISOString()
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(client.createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Planning', starts_at: expectedStart, ends_at: expectedEnd, reminder_at: new Date(reminder.value).toISOString() }), expect.objectContaining({ queueOnOffline: false, idempotencyKey: expect.any(String) }))
    expect(host.textContent).toContain('Event saved.')
  })

  it('disables saving while the backend is offline', async () => {
    client.calendarOccurrences.mockRejectedValue(new Error('offline'))
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root?.render(<CalendarView apiStatus="offline" />) })
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Create event'))!.click() })
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(client.createCalendarEvent).not.toHaveBeenCalled()
  })

  it('edits original series dates when a later occurrence is opened', async () => {
    const start = new Date(); start.setHours(9, 0, 0, 0)
    const end = new Date(start.getTime() + 3_600_000)
    const later = new Date(start); later.setDate(later.getDate() + (later.getDay() === 0 ? -1 : 1))
    const series = { id: 'series-1', version: 3, title: 'Recurring planning', starts_at: start.toISOString(), ends_at: end.toISOString(), timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=4', series_starts_at: start.toISOString(), series_ends_at: end.toISOString() }
    client.calendarOccurrences.mockResolvedValue([{ ...series, occurrence_id: 'first' }, { ...series, occurrence_id: 'later', starts_at: later.toISOString(), ends_at: new Date(later.getTime() + 3_600_000).toISOString() }])
    client.calendarReminders.mockResolvedValue([]); client.updateCalendarEvent.mockResolvedValue(series)
    const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => root?.render(<CalendarView apiStatus="ready" />))
    const buttons = [...host.querySelectorAll('button')].filter((button) => button.textContent?.includes('Recurring planning'))
    expect(buttons).toHaveLength(2)
    await act(async () => buttons[buttons.length - 1]!.click())
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('series-1', expect.objectContaining({ starts_at: start.toISOString(), ends_at: end.toISOString(), version: 3 }), { queueOnOffline: false })
  })
})
