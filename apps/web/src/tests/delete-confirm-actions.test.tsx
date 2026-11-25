import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsDesktop } from '../views/projects/ProjectsView.desktop'
import { ProjectsMobile } from '../views/projects/ProjectsView.mobile'
import { NotesDesktop } from '../views/notes/NotesView.desktop'
import { NotesMobile } from '../views/notes/NotesView.mobile'

const client = vi.hoisted(() => ({ projects: vi.fn(), tasks: vi.fn(), notes: vi.fn(), notesPage: vi.fn(), note: vi.fn(), deleteProject: vi.fn(), deleteNote: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const project = { id: 'p1', name: 'Sample project', description: '', status: 'active', version: 1 }
const note = { id: 'n1', title: 'Sample note', markdown_body: '', version: 1, parent_id: null, project_id: null }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!
const dialogButton = (label: string) => [...dialog().querySelectorAll('button')].find(button => button.textContent === label)!
async function click(element: HTMLElement) { await act(async () => element.click()) }
beforeEach(() => {
  vi.resetAllMocks()
  client.projects.mockResolvedValue([project]); client.tasks.mockResolvedValue([]); client.notes.mockResolvedValue([note]); client.note.mockResolvedValue(note)
  client.notesPage.mockResolvedValue({ items: [note], next_cursor: null, etag: 'notes' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
for (const [label, Component, kind] of [
  ['desktop projects', ProjectsDesktop, 'project'], ['mobile projects', ProjectsMobile, 'project'],
  ['desktop notes', NotesDesktop, 'note'], ['mobile notes', NotesMobile, 'note'],
] as const) describe(label, () => {
  async function open() {
    await act(async () => root.render(<Component apiStatus="ready" />))
    if (kind === 'project') { const card = host.querySelector<HTMLButtonElement>('.pv-card-open'); if (card) await click(card); await click([...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete')!) }
    else { await click(host.querySelector<HTMLButtonElement>('[aria-label="Delete note"]')!) }
  }
  it('opens focused on cancel, supports Escape and does not delete', async () => {
    await open(); expect(dialog().textContent).toContain(kind === 'project' ? project.name : note.title)
    expect(document.activeElement).toBe(dialogButton('Cancel'))
    await act(async () => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(dialogButton('Delete'))
    await act(async () => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(client.deleteProject).not.toHaveBeenCalled(); expect(client.deleteNote).not.toHaveBeenCalled()
  })
  it('cancels and reports API errors without losing the target', async () => {
    await open(); await click(dialogButton('Cancel')); expect(host.querySelector('[role="dialog"]')).toBeNull()
    await open(); (kind === 'project' ? client.deleteProject : client.deleteNote).mockRejectedValueOnce(new Error('failure'))
    await click(dialogButton('Delete')); expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Could not')
    expect(dialog().textContent).toContain(kind === 'project' ? project.name : note.title)
  })
  it('submits once and closes only after success', async () => {
    let finish!: () => void
    const request = kind === 'project' ? client.deleteProject : client.deleteNote
    request.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    await open()
    const confirm = dialogButton('Delete')
    await act(async () => { confirm.click(); confirm.click() })
    expect(request).toHaveBeenCalledTimes(1); expect(confirm.disabled).toBe(true)
    await act(async () => finish()); expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
})

for (const [label, Component] of [['desktop', ProjectsDesktop], ['mobile', ProjectsMobile]] as const) it(`${label} project menu confirms the intended card`, async () => {
  await act(async () => root.render(<Component apiStatus="ready" />))
  await click(host.querySelector<HTMLButtonElement>('[aria-label="Project actions: Sample project"]')!)
  await click([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Delete')!)
  expect(dialog().textContent).toContain('Sample project')
  expect(client.deleteProject).not.toHaveBeenCalled()
})
