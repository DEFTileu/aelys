import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DraftConflict, readDrafts, useDurableDrafts, writeDraftPatch, writeDrafts } from '../lib/durableDrafts'

const partition = vi.hoisted(() => ({ value: 'owner-a:backend-a' }))
vi.mock('../lib/api', () => ({ getDraftPartition: async (kind: string) => `${partition.value}:${kind}` }))
let root: Root
let host: HTMLDivElement
function Probe() {
  const { drafts, setDrafts, ready, status } = useDurableDrafts<{ note?: { body: string; version: number } }>('notes')
  return <><span>{drafts.note?.body}</span><p>{status}</p><button disabled={!ready} onClick={() => setDrafts({ note: { body: 'Unsynced text', version: 7 } })}>Edit</button></>
}
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<Probe />))
  await vi.waitFor(() => expect(host.querySelector('button')?.disabled).toBe(false))
}
async function close() { await act(async () => root.unmount()); host.remove() }
beforeEach(() => { partition.value = crypto.randomUUID() })
afterEach(async () => { if (host?.isConnected) await close() })
it('restores unsynced Markdown and its original version after unmount/reopen', async () => {
  await mount()
  await act(async () => host.querySelector('button')!.click())
  await vi.waitFor(() => expect(host.textContent).toContain('Drafts saved on this device'))
  await close(); await mount()
  expect(host.textContent).toContain('Unsynced text')
  expect((await readDrafts<{ note: { version: number } }>(`${partition.value}:notes`))?.note.version).toBe(7)
})
it('never hydrates another owner or backend partition', async () => {
  await writeDrafts('foreign-owner:notes', { note: { body: 'Private foreign draft', version: 1 } })
  await mount()
  expect(host.textContent).not.toContain('Private foreign draft')
})
it('reports a storage failure instead of claiming persistence', async () => {
  const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('storage unavailable') })
  try {
    await mount()
    expect(host.textContent).toContain('Local draft storage unavailable')
    expect(host.textContent).not.toContain('Drafts saved on this device')
  } finally { spy.mockRestore() }
})

it('merges independent entries and rejects an overwrite from a stale tab', async () => {
  const key = crypto.randomUUID()
  await writeDraftPatch(key, {}, { first: 'Draft A' })
  await writeDraftPatch(key, {}, { second: 'Draft B' })
  expect(await readDrafts(key)).toEqual({ first: 'Draft A', second: 'Draft B' })
  await expect(writeDraftPatch(key, {}, { first: 'Stale replacement' })).rejects.toBeInstanceOf(DraftConflict)
  expect(await readDrafts(key)).toEqual({ first: 'Draft A', second: 'Draft B' })
})
