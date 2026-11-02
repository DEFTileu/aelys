import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarView } from '../views/CalendarView'

const client = vi.hoisted(() => ({ calendarOccurrences: vi.fn(), calendarReminders: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<CalendarView apiStatus="ready" />)) }

beforeEach(() => {
  vi.resetAllMocks()
  client.calendarReminders.mockResolvedValue([])
  window.history.replaceState({}, '', '/calendar')
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('mobile calendar', () => {
  it('renders a week strip and day agenda without the hour grid', async () => {
    client.calendarOccurrences.mockResolvedValue([])
    await mount()
    expect(host.querySelector('.calendar-m')).not.toBeNull()
    expect(host.querySelector('.calendar-live')).toBeNull()
    expect(host.querySelector('.cl-grid')).toBeNull()
    expect(host.querySelectorAll('.calendar-m-strip button')).toHaveLength(7)
    expect(host.textContent).toContain('No events on this day.')
  })

  it('opens the event sheet from the FAB and closes it from the scrim', async () => {
    client.calendarOccurrences.mockResolvedValue([])
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Create event"]')!.click())
    expect(host.querySelector('[role="dialog"][aria-label="New event"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="New event title"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLDivElement>('.calendar-m-scrim')!.click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens a tapped agenda event in the edit sheet', async () => {
    const start = new Date(); start.setHours(10, 0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    client.calendarOccurrences.mockResolvedValue([{ occurrence_id: 'o1', id: 'e1', version: 1, title: 'Standup', starts_at: start.toISOString(), ends_at: end.toISOString(), series_starts_at: start.toISOString(), series_ends_at: end.toISOString(), rrule: null, timezone: 'UTC' }])
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('.calendar-m-event')!.click())
    expect(host.querySelector('[role="dialog"][aria-label="Edit event"]')).not.toBeNull()
    expect(host.querySelector<HTMLInputElement>('[aria-label="New event title"]')?.value).toBe('Standup')
  })
})
