import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { NotesView } from '../views/NotesView'

const client = vi.hoisted(() => ({ notes: vi.fn(), note: vi.fn(), updateNote: vi.fn(), createNote: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

const first = { id: '1', title: 'Alpha', markdown_body: 'Original', version: 1, parent_id: 'parent', project_id: 'project' }
const second = { id: '2', title: 'Beta', markdown_body: 'Second', version: 3, parent_id: null, project_id: null }
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text))!
const input = (label: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
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
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = '' })

describe('note drafts', () => {
  it('keeps the editor draft when opening and cancelling creation', async () => {
    await mount(); await change('Note body', 'Unsaved body'); await click('New note'); await change('New note title', 'New'); await click('Cancel')
    expect(input('Note body').value).toBe('Unsaved body')
    expect(input('Note title').value).toBe('Alpha')
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
    expect(client.updateNote).toHaveBeenCalledWith('1', { title: 'Edited', markdown_body: 'Saved body', parent_id: 'parent', project_id: 'project' }, { query: { version: 1 }, queueOnOffline: false })
    expect(host.textContent).toContain('v2'); expect(input('Note body').value).toBe('Saved body')
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
    await click('New note'); expect(host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
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
    await mount(); await click('New note'); await change('New note title', 'New')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(client.createNote).toHaveBeenCalledWith({ title: 'New', markdown_body: '' }, expect.objectContaining({ queueOnOffline: false, idempotencyKey: expect.any(String) }))
    expect(input('New note title').value).toBe('New'); expect(host.textContent).toContain('may have succeeded')
    expect(host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
  })
})
