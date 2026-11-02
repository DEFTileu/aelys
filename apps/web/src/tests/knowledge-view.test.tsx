import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeView } from '../views/KnowledgeView'
import { NotesView } from '../views/NotesView'

const client = vi.hoisted(() => ({ notes: vi.fn(), projects: vi.fn(), updateNote: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const ask = vi.hoisted(() => vi.fn())
vi.mock('../lib/desktopStore', () => ({ askAelys: ask }))
const records = [
  { id: 'first', title: 'Alpha', markdown_body: '# Heading\n<script>alert(1)</script>', parent_id: null, project_id: null, version: 1, knowledge_enabled: true },
  { id: 'second/with space', title: 'Beta', markdown_body: 'Findable text', parent_id: null, project_id: null, version: 2, knowledge_enabled: true },
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
    expect(host.querySelector('.knowledge-content .markdown-content h1')?.textContent).toBe('Heading')
    expect(host.querySelector('.knowledge-content script')).toBeNull()
    expect(host.querySelector('.knowledge-content')?.textContent).toContain('<script>alert(1)</script>')
    expect(host.querySelector('.knowledge-reader-head')?.textContent).not.toContain('Version 1')
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
    await mount(); expect(host.textContent).toContain('Can’t reach Aelys')
    await click('Retry'); expect(host.textContent).toContain('No notes yet.')
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
    expect(headings).toContain('Alpha')
    expect(headings).toContain('Real project')
  })

})

it('requires explicit source opt-in and preserves current note fields and version', async () => {
  const note = { ...records[0], knowledge_enabled: false }
  client.notes.mockResolvedValue([note])
  client.updateNote.mockResolvedValue({ ...note, knowledge_enabled: true, version: 2 })
  await mount()
  expect(host.querySelector('.knowledge-content')).toBeNull()
  await click('Manage sources'); await click('Enable for AI')
  expect(client.updateNote).toHaveBeenCalledWith('first', expect.objectContaining({ title: 'Alpha', markdown_body: note.markdown_body, knowledge_enabled: true }), { query: { version: 1 }, queueOnOffline: false })
  expect(host.textContent).toContain('Disable for AI')
  expect(host.textContent).toContain('Questions may send excerpts')
})
it('hands a document or project question to AI with an explicit retrieval scope', async () => {
  client.projects.mockResolvedValue([{ id: 'p1', name: 'Project' }])
  client.notes.mockResolvedValue([{ ...records[0], project_id: 'p1' }])
  await mount()
  await input('Question about knowledge', 'Explain this document')
  const form = host.querySelector<HTMLFormElement>('.knowledge-ask')!
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(ask).toHaveBeenLastCalledWith('Explain this document', { note_ids: ['first'] })
  await act(async () => {
    const project = host.querySelector<HTMLSelectElement>('[aria-label="Knowledge project"]')!
    project.value = 'p1'; project.dispatchEvent(new Event('change', { bubbles: true }))
    const scope = host.querySelector<HTMLSelectElement>('[aria-label="Question scope"]')!
    scope.value = 'library'; scope.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(ask).toHaveBeenLastCalledWith('Explain this document', { project_id: 'p1' })
})
