import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksView } from '../views/TasksView'
import { CalendarView } from '../views/CalendarView'
import { MailView } from '../views/MailView'

const client = vi.hoisted(() => ({ tasks: vi.fn(), projects: vi.fn(), calendarOccurrences: vi.fn(), calendarReminders: vi.fn(), mailMessages: vi.fn(), mailDrafts: vi.fn(), mailAccounts: vi.fn(), gmailStatus: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(element)) }
async function route(url: string) { await act(async () => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')) }) }
async function fill(label: string, value: string) { const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!.click()) }
const task = (id: string) => ({ id, version: 1, title: id, description: '', project_id: null, parent_task_id: null, status: 'todo', priority: 0, due_at: null, due_timezone: null, rrule: null })
const mail = (id: string) => ({ id, sender: 'sender@example.test', recipients: ['owner@example.test'], subject: id, body: 'body', received_at: '2026-10-29T12:00:00Z', thread_id: null })
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); client.tasks.mockResolvedValue([task('one'), task('two')]); client.projects.mockResolvedValue([]); client.calendarOccurrences.mockResolvedValue([]); client.calendarReminders.mockResolvedValue([]); client.mailMessages.mockResolvedValue([mail('one'), mail('two')]); client.mailDrafts.mockResolvedValue([]); client.mailAccounts.mockResolvedValue([]); client.gmailStatus.mockResolvedValue({ configured: false }) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; history.replaceState({}, '', '/'); vi.unstubAllGlobals() })

describe('search destination intents', () => {
  it('opens task selection after loading and parks edits across same-route intents', async () => {
    history.replaceState({}, '', '/tasks?task=one')
    await mount(<TasksView apiStatus="ready" />)
    expect(host.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe('one')
    await fill('Task title', 'Unsaved one')
    await route('/tasks?task=two')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe('two')
    await route('/tasks?task=one')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe('Unsaved one')
    await route('/tasks?create=1')
    await fill('New task title', 'New draft')
    await route('/tasks?task=two')
    await route('/tasks?create=1')
    expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')?.value).toBe('New draft')
    await route('/tasks?task=one')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe('Unsaved one')
  })
  it('uses the styled task picker and preserves its native change contract', async () => {
    history.replaceState({}, '', '/tasks?task=one')
    client.projects.mockResolvedValue([{ id: 'project-1', name: 'Orion', description: '', status: 'active', version: 1 }])
    await mount(<TasksView apiStatus="ready" />)
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Project"]')!
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].find(button => button.getAttribute('aria-labelledby') && document.getElementById(button.getAttribute('aria-labelledby')!)?.textContent === 'Project')!
    await act(async () => trigger.click())
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === 'Orion')!.click())
    expect(select.value).toBe('project-1')
    expect(trigger.textContent).toContain('Orion')
  })
  it('opens a calendar create draft on mount and keeps it on repeated intents', async () => {
    history.replaceState({}, '', '/calendar?create=1')
    await mount(<CalendarView apiStatus="ready" />)
    await fill('New event title', 'Planning draft')
    await route('/calendar?create=1')
    expect(host.querySelector<HTMLInputElement>('[aria-label="New event title"]')?.value).toBe('Planning draft')
  })
  it('parks an event edit when creation is requested', async () => {
    const start = new Date(); start.setHours(9, 0, 0, 0); const end = new Date(start.getTime() + 3600000)
    client.calendarOccurrences.mockResolvedValue([{ id: 'e1', version: 1, occurrence_id: 'e1', title: 'Event', starts_at: start.toISOString(), ends_at: end.toISOString(), series_starts_at: start.toISOString(), series_ends_at: end.toISOString(), timezone: 'UTC', rrule: null }])
    history.replaceState({}, '', '/calendar')
    await mount(<CalendarView apiStatus="ready" />)
    await act(async () => host.querySelector<HTMLButtonElement>('.cl-day button')!.click())
    await fill('New event title', 'Edited event')
    await route('/calendar?create=1')
    expect(host.querySelector<HTMLInputElement>('[aria-label="New event title"]')?.value).toBe('')
    await click('Resume event edit')
    expect(host.querySelector<HTMLInputElement>('[aria-label="New event title"]')?.value).toBe('Edited event')
  })
  it('opens mail by id on mount and same-route navigation while preserving compose and reply drafts', async () => {
    history.replaceState({}, '', '/mail?mail=two')
    await mount(<MailView apiStatus="ready" />)
    expect(host.querySelector('article h2')?.textContent).toBe('two')
    await fill('Reply draft', 'Reply to two')
    await route('/mail?mail=one'); await route('/mail?mail=two')
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Reply draft"]')?.value).toBe('Reply to two')
    await click('Compose'); await fill('Draft subject', 'Compose draft')
    await route('/mail?mail=one')
    expect(host.querySelector('article h2')?.textContent).toBe('one')
    await click('Resume draft')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Draft subject"]')?.value).toBe('Compose draft')
  })
})
