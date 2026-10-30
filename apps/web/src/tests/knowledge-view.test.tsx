import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeView } from '../views/KnowledgeView'
import { NotesView } from '../views/NotesView'

const client = vi.hoisted(() => ({ notes: vi.fn(), projects: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const records = [
  { id: 'first', title: 'Alpha', markdown_body: '# Heading\n<script>alert(1)</script>', parent_id: null, project_id: null, version: 1 },
  { id: 'second/with space', title: 'Beta', markdown_body: 'Findable text', parent_id: null, project_id: null, version: 2 },
]
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<KnowledgeView apiStatus="ready" />)) }
function button(label: string) { return [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))! }
async function click(label: string) { await act(async () => button(label).click()) }
async function input(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
beforeEach(() => { vi.resetAllMocks(); client.notes.mockResolvedValue(records); client.projects.mockResolvedValue([]); window.history.replaceState({}, '', '/knowledge') })
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; window.history.replaceState({}, '', '/') })

describe('knowledge view', () => {
  it('reads real notes safely and searches their body', async () => {
    await mount()
    expect(host.querySelector('.knowledge-content h1')?.textContent).toBe('Alpha')
    expect(host.querySelector('.knowledge-content h2')?.textContent).toBe('Heading')
    expect(host.querySelector('.knowledge-content script')).toBeNull()
    expect(host.querySelector('.knowledge-content')?.textContent).toContain('<script>alert(1)</script>')
    expect(host.querySelector('.knowledge-reader-head')?.textContent).toContain('Note · v1')
    await input('Search documents', 'findable')
    expect(host.querySelector('.knowledge-content h1')?.textContent).toBe('Beta')
    expect(host.querySelector('.knowledge-items')?.textContent).not.toContain('Alpha')
  })
  it('filters by title and switches between mobile list and reader', async () => {
    await mount()
    await input('Search documents', 'Beta')
    expect(host.querySelector('.knowledge-items')?.textContent).not.toContain('Alpha')
    await click('Beta'); expect(host.querySelector('.knowledge-view--reading')).not.toBeNull()
    await click('Back'); expect(host.querySelector('.knowledge-view--reading')).toBeNull()
  })
  it('retries errors and handles empty records without inventing metadata', async () => {
    client.notes.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
    await mount(); expect(host.textContent).toContain('Knowledge is unavailable')
    await click('Try again'); expect(host.textContent).toContain('No notes yet.')
    expect(client.notes).toHaveBeenCalledTimes(2)
  })
  it('opens the selected note in the Notes editor using an encoded deep link', async () => {
    await mount(); await click('Beta'); await click('Edit note')
    expect(window.location.pathname).toBe('/notes')
    expect(new URLSearchParams(window.location.search).get('note')).toBe('second/with space')
    await act(async () => root.render(<NotesView apiStatus="ready" />))
    expect(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')?.value).toBe('Beta')
    expect(host.querySelector('.notes-live--editing')).not.toBeNull()
  })
  it('groups notes using existing parent and project relationships', async () => {
    client.notes.mockResolvedValue([records[0], { ...records[1], parent_id: 'first' }, { ...records[1], id: 'third', title: 'Gamma', project_id: 'p1' }])
    client.projects.mockResolvedValue([{ id: 'p1', name: 'Real project', description: '', status: 'active', version: 1 }])
    await mount()
    const headings = [...host.querySelectorAll('.knowledge-items h2')].map((item) => item.textContent)
    expect(headings).toContain('Alpha 1')
    expect(headings).toContain('Real project 1')
  })

})
