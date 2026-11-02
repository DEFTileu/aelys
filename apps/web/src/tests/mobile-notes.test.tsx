import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotesView } from '../views/NotesView'

const client = vi.hoisted(() => ({ notes: vi.fn(), note: vi.fn(), updateNote: vi.fn(), createNote: vi.fn(), deleteNote: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const first = { id: '1', title: 'Alpha', markdown_body: 'Original', version: 1, parent_id: null, project_id: null, folder: 'Work' }
const second = { id: '2', title: 'Beta', markdown_body: 'Second', version: 1, parent_id: null, project_id: null }
const originalMatchMedia = window.matchMedia
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)!
async function click(element: HTMLElement) { await act(async () => element.click()) }
async function setInput(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(async () => {
  vi.resetAllMocks()
  window.matchMedia = vi.fn((query: string) => ({ matches: query === '(max-width: 700px)', media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
  client.notes.mockResolvedValue([first, second])
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<NotesView apiStatus="ready" />))
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; window.matchMedia = originalMatchMedia; window.history.replaceState({}, '', '/') })

describe('mobile notes', () => {
  it('renders the mobile list and never the desktop layout', () => {
    expect(host.querySelector('.notes-m')).not.toBeNull()
    expect(host.querySelector('.notes-live')).toBeNull()
    expect(host.querySelector('.notes-m-list')?.textContent).toContain('Beta')
    expect(host.querySelector('[aria-label="New note"]')).not.toBeNull()
  })

  it('replaces the list with the editor and returns on Back', async () => {
    await click(button('Alpha'))
    expect(host.querySelector('.notes-m-editor')).not.toBeNull()
    expect(host.querySelector('.notes-m-list')).toBeNull()
    await click(host.querySelector<HTMLButtonElement>('.notes-m-back')!)
    expect(host.querySelector('.notes-m-editor')).toBeNull()
    expect(host.querySelector('.notes-m-list')).not.toBeNull()
  })

  it('creates a note from the sheet and opens it in the editor', async () => {
    client.createNote.mockResolvedValue({ id: '3', title: 'Fresh', markdown_body: '', version: 1, parent_id: null, project_id: null })
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New note"]')!)
    await setInput('New note title', 'Fresh')
    await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(client.createNote).toHaveBeenCalledWith({ title: 'Fresh', markdown_body: '' }, expect.objectContaining({ queueOnOffline: false }))
    expect(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')?.value).toBe('Fresh')
  })
})
