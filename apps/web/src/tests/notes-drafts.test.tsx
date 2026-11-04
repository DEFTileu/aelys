import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { NotesView } from '../views/NotesView'

const client = vi.hoisted(() => ({ notes: vi.fn(), notesPage: vi.fn(), note: vi.fn(), updateNote: vi.fn(), createNote: vi.fn(), deleteNote: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const first = { id: '1', title: 'Alpha', markdown_body: 'Original', version: 1, parent_id: 'parent', project_id: 'project' }
const second = { id: '2', title: 'Beta', markdown_body: 'Second', version: 3, parent_id: null, project_id: null }
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)!
const input = (label: string) => {
  const rich = host.querySelector<HTMLElement>(`[contenteditable][aria-label="${label}"]`)?.closest('.rich-text')
  if (rich) { const source = [...rich.querySelectorAll('button')].find(button => button.textContent === 'Markdown'); if (source) act(() => source.click()) }
  return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[aria-label="${label}"],textarea[aria-label="${label}"]`)!
}
async function change(label: string, value: string) {
  const element = input(label)
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function click(text: string) { await act(async () => button(text).click()) }
async function mount(status: 'ready' | 'offline' = 'ready') {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<NotesView apiStatus={status} />))
}

beforeEach(() => { vi.resetAllMocks(); client.notes.mockResolvedValue([first, second]); client.note.mockResolvedValue(first) })
beforeEach(() => { client.notesPage.mockImplementation(async () => ({ items: await client.notes(), next_cursor: null, etag: 'notes' })); })

afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = '' })

describe('note drafts', () => {
  it('filters unfiled notes and keeps drafts through the mobile list transition', async () => {
    await mount(); await change('Note body', 'Alpha draft'); await click('Unfiled')
    expect(host.querySelector('.nl-note-list')?.textContent).toContain('Beta')
    expect(host.querySelector('.nl-note-list')?.textContent).toContain('Alpha')
    await click('Beta'); expect(host.querySelector('.notes-live--editing')).not.toBeNull()
    await click('← All notes'); expect(host.querySelector('.notes-live--editing')).toBeNull()
    await click('All notes'); await click('Alpha'); expect(input('Note body').value).toBe('Alpha draft')
  })
  const created = { id: '3', title: '', markdown_body: '', version: 1, parent_id: null, project_id: null, folder: null, tags: [], updated_at: new Date().toISOString() }
  it('creates an empty Untitled note at the top of the list like the design, selects it and focuses the title', async () => {
    client.createNote.mockResolvedValue(created)
    await mount(); await change('Note body', 'Unsaved body')
    await act(async () => { button('New note').click(); await new Promise((resolve) => setTimeout(resolve, 80)) })
    expect(client.createNote).toHaveBeenCalledWith({ title: '', markdown_body: '' }, expect.objectContaining({ queueOnOffline: false, idempotencyKey: expect.any(String) }))
    const rows = [...host.querySelectorAll('.nl-note')]
    expect(rows).toHaveLength(3)
    expect(rows[0]!.className).toContain('nl-note--active')
    expect(rows[0]!.textContent).toContain('Untitled'); expect(rows[0]!.textContent).toContain('Just now'); expect(rows[0]!.textContent).toContain('No content yet')
    expect(input('Note title').value).toBe(''); expect(document.activeElement).toBe(input('Note title'))
    expect(host.querySelector('.nl-editor-actions')!.textContent).toContain('0 words')
    expect(host.querySelector('form.nl-form')).toBeNull()
    await click('Alpha')
    expect(input('Note body').value).toBe('Unsaved body')
  })
  it('puts the new note in the open folder and under the active tag', async () => {
    client.notes.mockResolvedValue([{ ...first, folder: 'Work', tags: ['plan'] }])
    client.createNote.mockResolvedValue({ ...created, folder: 'Work', tags: ['plan'] })
    await mount(); await click('Work'); await click('#plan'); await click('New note')
    expect(client.createNote).toHaveBeenCalledWith({ title: '', markdown_body: '', folder: 'Work', tags: ['plan'] }, expect.anything())
  })
  it('keeps separate drafts across selection and search', async () => {
    await mount(); await change('Note body', 'Alpha draft'); await click('Beta'); await change('Note body', 'Beta draft')
    await change('Search notes', 'Alpha'); expect(input('Note body').value).toBe('Alpha draft')
    await change('Search notes', 'Beta'); expect(input('Note body').value).toBe('Beta draft')
    await change('Search notes', ''); await click('Alpha'); expect(input('Note body').value).toBe('Alpha draft')
  })
  it('saves the full note and uses the returned version as the next base', async () => {
    const saved = { ...first, title: 'Edited', markdown_body: 'Saved body', version: 2 }
    client.updateNote.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, version: 3 })
    await mount(); await change('Note title', 'Edited'); await change('Note body', 'Saved body'); await click('Save changes')
    expect(client.updateNote).toHaveBeenCalledWith('1', { title: 'Edited', markdown_body: 'Saved body', parent_id: 'parent', project_id: 'project', knowledge_enabled: false }, { query: { version: 1 }, queueOnOffline: false })
    expect(host.textContent).not.toContain('v2'); expect(input('Note body').value).toBe('Saved body')
    await change('Note body', 'Next'); await click('Save changes')
    expect(client.updateNote).toHaveBeenLastCalledWith('1', expect.objectContaining({ markdown_body: 'Next' }), { query: { version: 2 }, queueOnOffline: false })
  })
  it('shows success only while the saved content is current, including offline edits', async () => {
    client.updateNote.mockResolvedValueOnce({ ...first, title: 'Edited', markdown_body: 'Saved', version: 2 })
    await mount(); await change('Note title', 'Edited'); await change('Note body', 'Saved'); await click('Save changes')
    expect(host.textContent).toContain('Changes saved.')
    await change('Note title', 'Unsaved title')
    expect(host.textContent).not.toContain('Changes saved.')
    await act(async () => root.render(<NotesView apiStatus="offline" />))
    await change('Note body', 'Offline draft')
    expect(host.textContent).not.toContain('Changes saved.')
    expect(input('Note body').value).toBe('Offline draft')
  })
  it('does not report success for a newer draft typed during save', async () => {
    let finish!: (value: typeof first) => void
    client.updateNote.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    await mount(); await change('Note body', 'Sent'); await click('Save changes')
    await change('Note body', 'Newer draft')
    await act(async () => finish({ ...first, markdown_body: 'Sent', version: 2 }))
    expect(input('Note body').value).toBe('Newer draft')
    expect(host.textContent).not.toContain('Changes saved.')
  })
  it('does not show a completed save on another selected note', async () => {
    let finish!: (value: typeof first) => void
    client.updateNote.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    await mount(); await change('Note body', 'Sent'); await click('Save changes'); await click('Beta')
    await act(async () => finish({ ...first, markdown_body: 'Sent', version: 2 }))
    expect(input('Note title').value).toBe('Beta')
    expect(host.textContent).not.toContain('Changes saved.')
    await click('Alpha')
    expect(host.textContent).not.toContain('Changes saved.')
  })
  it('clears success when going offline without another edit', async () => {
    client.updateNote.mockResolvedValueOnce({ ...first, markdown_body: 'Saved', version: 2 })
    await mount(); await change('Note body', 'Saved'); await click('Save changes')
    expect(host.textContent).toContain('Changes saved.')
    await act(async () => root.render(<NotesView apiStatus="offline" />))
    expect(host.textContent).not.toContain('Changes saved.')
  })
  it('retains drafts on conflict and network failure', async () => {
    await mount(); await change('Note body', 'Draft')
    client.updateNote.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Changed')); await click('Save changes')
    expect(input('Note body').value).toBe('Draft'); expect(host.textContent).toContain('changed on the server')
    expect(client.updateNote).toHaveBeenCalledWith('1', expect.objectContaining({ markdown_body: 'Draft' }), { query: { version: 1 }, queueOnOffline: false })
    expect(client.note).not.toHaveBeenCalled(); expect(client.notes).toHaveBeenCalledTimes(1)
    client.note.mockResolvedValueOnce({ ...first, markdown_body: 'Remote', version: 2 }); await click('Review latest version')
    expect(host.textContent).toContain('Remote'); expect(input('Note body').value).toBe('Draft')
    await click('Keep my draft and use this version')
    client.updateNote.mockRejectedValueOnce(new Error('network')); await click('Save changes')
    expect(client.updateNote).toHaveBeenLastCalledWith('1', expect.objectContaining({ markdown_body: 'Draft' }), { query: { version: 2 }, queueOnOffline: false })
    expect(input('Note body').value).toBe('Draft'); expect(host.textContent).toContain('draft is preserved')
  })
  it('blocks overlapping writes and does not queue offline', async () => {
    let finish!: (value: typeof first) => void
    client.updateNote.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await mount(); await change('Note body', 'Draft')
    await act(async () => { button('Save changes').click(); button('Save changes').click() })
    expect(client.updateNote).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ...first, markdown_body: 'Draft', version: 2 }))
    await act(async () => root.render(<NotesView apiStatus="offline" />))
    expect(input('Note body').value).toBe('Draft'); expect(button('Save changes').disabled).toBe(true)
    await click('New note'); expect(host.textContent).toContain('OFFLINE_WRITE_UNAVAILABLE')
    expect(client.createNote).not.toHaveBeenCalled()
  })
  it('preserves newer edits during a save and across a reload', async () => {
    let finish!: (value: typeof first) => void
    client.updateNote.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await mount(); await change('Note body', 'Sent'); await act(async () => button('Save changes').click())
    await change('Note body', 'Typed during save')
    await act(async () => finish({ ...first, markdown_body: 'Sent', version: 2 }))
    expect(input('Note body').value).toBe('Typed during save')
    client.notes.mockResolvedValue([{ ...first, markdown_body: 'Server refresh', version: 3 }, second])
    await act(async () => root.render(<NotesView apiStatus="offline" />))
    await act(async () => root.render(<NotesView apiStatus="ready" />))
    expect(input('Note body').value).toBe('Typed during save')
    client.updateNote.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Changed')); await click('Save changes')
    expect(client.updateNote).toHaveBeenLastCalledWith('1', expect.objectContaining({ markdown_body: 'Typed during save' }), { query: { version: 2 }, queueOnOffline: false })
    expect(input('Note body').value).toBe('Typed during save')
  })
  it('does not blindly retry an ambiguous create', async () => {
    client.createNote.mockRejectedValue(new Error('network'))
    await mount(); await click('New note')
    expect(host.textContent).toContain('may have succeeded')
    await click('New note')
    expect(client.createNote).toHaveBeenCalledTimes(1)
  })
  it('renders sanitized Markdown and saves an edited checklist without saving on load', async () => {
    client.notes.mockResolvedValue([{ ...first, markdown_body: '**hello** <script>bad()</script>\n\n- [ ] task\n- [x] done' }, second])
    await mount()
    const editor = host.querySelector<HTMLElement>('[contenteditable][aria-label="Note body"]')!
    expect(editor.querySelector('script')).toBeNull()
    expect(editor.querySelector('strong')?.textContent).toBe('hello')
    expect(editor.querySelectorAll('input[type=checkbox]')).toHaveLength(2)
    expect(client.updateNote).not.toHaveBeenCalled()
    await act(async () => editor.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    client.updateNote.mockResolvedValue({ ...first, version: 2 })
    await click('Save changes')
    expect(client.updateNote.mock.calls[0]![1].markdown_body).toContain('- [x] task')
  })

  it('confirms deletion and removes only the selected note after success', async () => {
    client.deleteNote.mockResolvedValue({}); vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount(); await click('Delete note')
    expect(client.deleteNote).toHaveBeenCalledWith('1', { queueOnOffline: false })
    expect(host.querySelector('.nl-note-list')?.textContent).not.toContain('Alpha')
    expect(host.querySelector('.nl-note-list')?.textContent).toContain('Beta')
    vi.restoreAllMocks()
  })

})

it('retains organization drafts when an older server ignores their fields', async () => {
  client.updateNote.mockResolvedValueOnce({ ...first, version: 2 })
  await mount(); await change('Note folder', 'Work'); await click('Save changes')
  expect(input('Note folder').value).toBe('Work')
  expect(host.textContent).toContain('server did not save folders and tags')
  expect(host.textContent).not.toContain('Changes saved.')
})

it('saves folder and tags with the note and filters saved organization', async () => {
  const saved = { ...first, folder: 'Work', tags: ['design'], version: 2 }
  client.updateNote.mockResolvedValue(saved)
  await mount(); await change('Note folder', 'Work'); await change('New tag', 'design'); await click('Add'); await click('Save changes')
  expect(client.updateNote).toHaveBeenCalledWith('1', expect.objectContaining({ folder: 'Work', tags: ['design'] }), expect.objectContaining({ query: { version: 1 } }))
  await click('Work'); expect(host.querySelector('.nl-note-list')?.textContent).toContain('Alpha')
  await click('#design'); expect(host.querySelector('.nl-note-list')?.textContent).toContain('Alpha')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove tag design"]')!.click()); await act(async () => root.render(<NotesView apiStatus="offline" />))
  expect(host.querySelector('[aria-label="Remove tag design"]')).toBeNull()
})

it('opens create and note intents on mount and same-route popstate', async () => {
  window.history.replaceState({}, '', '/notes?create=1')
  client.createNote.mockResolvedValue({ id: '3', title: '', markdown_body: '', version: 1, parent_id: null, project_id: null, folder: null, tags: [] })
  await mount(); expect(client.createNote).toHaveBeenCalledTimes(1); expect(input('Note title').value).toBe('')
  await act(async () => { window.history.pushState({}, '', '/notes?note=2'); window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(input('Note title').value).toBe('Beta')
  await act(async () => { window.history.pushState({}, '', '/notes?create=1'); window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(client.createNote).toHaveBeenCalledTimes(2)
  window.history.replaceState({}, '', '/')
})
