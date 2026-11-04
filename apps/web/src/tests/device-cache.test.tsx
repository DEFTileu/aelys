import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiClient, IndexedDbOfflineStore } from '@aelys/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksView } from '../views/TasksView'
import { NotesView } from '../views/NotesView'
import { MailView } from '../views/MailView'

const state = vi.hoisted(() => ({ client: undefined as ApiClient | undefined }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => state.client! }))

const records = [{ id: 'saved-task', title: 'Saved on device', description: '', project_id: null, parent_task_id: null, status: 'todo', priority: 0, due_at: null, due_timezone: null, rrule: null, version: 1 }]
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(status: 'ready' | 'offline') {
  await act(async () => root!.render(<TasksView apiStatus={status} />))
  await act(async () => host.querySelector<HTMLButtonElement>('[role=tab][aria-label=Inbox]')!.click())
}

async function waitForRender(assertion: () => void) {
  await vi.waitFor(async () => {
    // IndexedDB completes on later tasks; flush each completion through React.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assertion()
  })
}

function savedTask() { return host.querySelector('[aria-label="Open task: Saved on device"]') }

describe('Tasks device cache', () => {
  it('reopens IndexedDB and renders saved tasks offline without a single fetch', async () => {
    const name = `device-cache-${crypto.randomUUID()}`
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/tasks') ? records : [])))
    const first = new ApiClient({ baseUrl: '', fetch: fetchImpl, offlineStore: new IndexedDbOfflineStore(name) })
    await first.tasks()
    await first.projects()
    fetchImpl.mockClear()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    state.client = new ApiClient({ baseUrl: '', fetch: fetchImpl, offlineStore: new IndexedDbOfflineStore(name), isOnline: () => navigator.onLine })
    await mount('offline')
    await waitForRender(() => expect(savedTask()).not.toBeNull())
    expect(host.textContent).toMatch(/cached|cache/i)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Complete Saved on device"]')!.disabled).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses disk after failed live reads without repeating either network request', async () => {
    const store = new IndexedDbOfflineStore(`device-cache-${crypto.randomUUID()}`)
    await store.setCache('tasks', records)
    await store.setCache('projects', [])
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => { throw new TypeError('Backend unavailable') })
    state.client = new ApiClient({ baseUrl: '', fetch: fetchImpl, offlineStore: store, isOnline: () => true })
    await mount('ready')
    await waitForRender(() => expect(savedTask()).not.toBeNull())
    expect(fetchImpl.mock.calls.map(args => args[0])).toEqual(['/api/v1/tasks', '/api/v1/projects'])
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Complete Saved on device"]')!.disabled).toBe(true)
  })

  it('does not revive an expired snapshot or fetch while offline', async () => {
    const store = new IndexedDbOfflineStore(`device-cache-${crypto.randomUUID()}`)
    await store.setCache('tasks', records, -1)
    await store.setCache('projects', [])
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const fetchImpl = vi.fn()
    state.client = new ApiClient({ baseUrl: '', fetch: fetchImpl, offlineStore: store, isOnline: () => false })
    await mount('offline')
    await waitForRender(() => expect(host.textContent).toContain('Could not load tasks'))
    expect(savedTask()).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

const note = (id: string, title: string, version = 1) => ({ id, title, version, markdown_body: `${title} body`, parent_id: null, project_id: null, folder: null, tags: [] })
const page = <T,>(items: T[], next: string | null = null, etag = 'W/"v1"') => ({ items, next_cursor: next, etag, not_modified: false })
async function changeField(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('paged background refresh', () => {
  it('removes the saved preview when live authorization fails', async () => {
    const store = new IndexedDbOfflineStore(`denied-preview-${crypto.randomUUID()}`)
    await store.setCache('notes-pages?limit=50&q=', page([note('n1', 'Private saved note')]), undefined, 'W/"v1"')
    let finish!: (response: Response) => void
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/read/notes?')
      ? new Promise<Response>(resolve => { finish = resolve }) : new Response('[]'))
    state.client = new ApiClient({ baseUrl: '', offlineStore: store, fetch: fetchImpl })
    await act(async () => root!.render(<NotesView apiStatus="ready" />))
    await waitForRender(() => expect(host.textContent).toContain('Private saved note'))
    await act(async () => finish(new Response('Denied', { status: 403 })))
    await waitForRender(() => expect(host.textContent).not.toContain('Private saved note'))
    await expect(state.client.notesPage({ q: '', limit: 50 }, { cacheOnly: true })).rejects.toMatchObject({ code: 'CACHE_MISS' })
  })

  it('shows saved notes before a slow response and preserves text edited during refresh', async () => {
    const store = new IndexedDbOfflineStore(`preview-${crypto.randomUUID()}`)
    await store.setCache('notes-pages?limit=50&q=', page([note('n1', 'Saved')]), undefined, 'W/"v1"')
    let finish!: (response: Response) => void
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).includes('/read/notes?')
      ? new Promise<Response>(resolve => { finish = resolve }) : new Response('[]'))
    state.client = new ApiClient({ baseUrl: '', offlineStore: store, fetch: fetchImpl })
    await act(async () => root!.render(<NotesView apiStatus="ready" />))
    await waitForRender(() => expect(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')?.value).toBe('Saved'))
    expect(host.textContent).toContain('Saved on this device')
    await changeField('Note title', 'My local edit')
    expect([...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save changes')?.disabled).toBe(true)
    await act(async () => finish(new Response(JSON.stringify(page([note('n1', 'Server update', 2)], null, 'W/"v2"')), { headers: { ETag: 'W/"v2"' } })))
    await waitForRender(() => expect(host.textContent).toContain('Server update'))
    expect(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')?.value).toBe('My local edit')
    const request = fetchImpl.mock.calls.find(([url]) => String(url).includes('/read/notes?'))!
    expect(new Headers(request[1]?.headers).get('If-None-Match')).toBe('W/"v1"')
  })

  it('loads the next notes page on demand and searches beyond loaded pages', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test')
      if (url.pathname !== '/api/v1/read/notes') return new Response('[]')
      const value = url.searchParams.get('q') === 'outside'
        ? page([note('outside', 'outside loaded pages')])
        : url.searchParams.get('cursor') ? page([note('n2', 'Second page')]) : page([note('n1', 'First page')], 'next-page')
      return new Response(JSON.stringify(value))
    })
    state.client = new ApiClient({ baseUrl: '', fetch: fetchImpl })
    await act(async () => root!.render(<NotesView apiStatus="ready" />))
    expect(host.textContent).not.toContain('Second page')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Load more notes')!.click())
    expect(host.textContent).toContain('First page')
    expect(host.textContent).toContain('Second page')
    await changeField('Search notes', 'outside')
    await waitForRender(() => expect(host.textContent).toContain('outside loaded pages'))
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('q=outside'))).toBe(true)
  })

  it('loads mail in pages without delaying the inbox for metadata requests', async () => {
    const mail = (id: string) => ({ id, owner_id: 'owner', account_id: null, thread_id: null, sender: 'sender@example.test', recipients: [], subject: id, body: `${id} body`, received_at: '2026-10-29T12:00:00Z', sync_origin: 'import' })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test')
      if (url.pathname === '/api/v1/read/mail') return new Response(JSON.stringify(url.searchParams.get('cursor') ? page([mail('later-message')]) : page([mail('first-message')], 'mail-next')))
      if (url.pathname.endsWith('/gmail/status')) return new Response('{"configured":false}')
      return new Response('[]')
    })
    state.client = new ApiClient({ baseUrl: '', fetch: fetchImpl })
    await act(async () => root!.render(<MailView apiStatus="ready" />))
    expect(host.textContent).toContain('first-message')
    expect(host.textContent).not.toContain('later-message')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Load more messages')!.click())
    expect(host.textContent).toContain('later-message')
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/mail/messages'))).toBe(false)
  })
})
