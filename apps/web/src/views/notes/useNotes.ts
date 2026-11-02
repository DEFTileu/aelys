import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { NoteOut } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'

const ORG_COLORS = ['#14966C', '#D93636', '#D97706', '#2F6FE4', '#0F9488', '#D9367E', '#6A4CF2']
export const orgColor = (name: string) => ORG_COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % ORG_COLORS.length]
// Design wording: "Today, 10:24", "Yesterday", otherwise "Oct 26".
export function noteWhen(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback
  const date = new Date(iso), now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0) return `Today, ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export const snippetOf = (body: string) => body.split('\n').map((line) => line.replace(/^\s*(#{1,6}|[-*>])\s+/, '')).join(' ').replace(/\s+/g, ' ').trim() || 'Empty note'
const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`

// All Notes state and handlers; the desktop and mobile screens render from this.
export function useNotes(apiStatus: ApiStatus) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('all')
  const [tag, setTag] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const compactEditor = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches === true
  const [mobileEditor, setMobileEditor] = useState(() => !!new URLSearchParams(window.location.search).get('note'))
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('note'))
  type Draft = { title: string; body: string; folder: string; tags: readonly string[]; base: NoteOut }
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [createTitle, setCreateTitle] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [savedNotice, setSavedNotice] = useState<Pick<NoteOut, 'id' | 'title' | 'markdown_body'> | null>(null)
  const [writing, setWriting] = useState(false)
  const [conflictId, setConflictId] = useState<string | null>(null)
  const [latestConflict, setLatestConflict] = useState<NoteOut | null>(null)
  const [createUncertain, setCreateUncertain] = useState(false)
  const writeLock = useRef(false)
  const createOperation = useRef<string | null>(null)

  const load = async () => {
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try {
      const value = await getSharedApiClient().notes()
      setNotes(value); setSelectedId((current) => current ?? value[0]?.id ?? null); setStatus('ready')
    } catch { setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error') }
  }
  useEffect(() => { void load() }, [apiStatus])
  useEffect(() => {
    const applyIntent = () => {
      if (window.location.pathname.replace(/\/$/, '') !== '/notes') return
      const params = new URLSearchParams(window.location.search)
      if (params.get('create') === '1') setFormOpen(true)
      const noteId = params.get('note')
      if (noteId) { setFolder('all'); setTag(null); setQuery(''); setSelectedId(noteId); setMobileEditor(true); setFormOpen(false) }
    }
    applyIntent()
    window.addEventListener('popstate', applyIntent)
    return () => window.removeEventListener('popstate', applyIntent)
  }, [])
  const folders = useMemo(() => [...new Set(notes.map((note) => note.folder).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b)), [notes])
  const tags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags ?? []))].sort((a, b) => a.localeCompare(b)), [notes])
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return notes.filter((note) => (folder === 'all' || (folder === 'unfiled' ? !note.folder : `folder:${note.folder}` === folder)) && (!tag || (note.tags ?? []).includes(tag)) && (!needle || `${note.title} ${note.markdown_body} ${(note.tags ?? []).join(' ')}`.toLowerCase().includes(needle))) }, [notes, query, folder, tag])
  const selected = visible.find((note) => note.id === selectedId) ?? visible[0]
  const draft = selected ? drafts[selected.id] ?? { title: selected.title, body: selected.markdown_body, folder: selected.folder ?? '', tags: selected.tags ?? [], base: selected } : undefined
  const editDraft = (change: Partial<Pick<Draft, 'title' | 'body' | 'folder' | 'tags'>>) => {
    if (!selected || !draft) return
    setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draft), ...change } }))
  }
  const canWrite = apiStatus === 'ready' && (typeof navigator === 'undefined' || navigator.onLine)
  const showSavedNotice = !!savedNotice && canWrite && selected?.id === savedNotice.id && draft?.title === savedNotice.title && draft.body === savedNotice.markdown_body && draft.folder === (selected?.folder ?? '') && JSON.stringify(draft.tags) === JSON.stringify(selected?.tags ?? [])
  useEffect(() => { if (savedNotice && !showSavedNotice) setSavedNotice(null) }, [savedNotice, showSavedNotice])
  const beginWrite = () => {
    if (!canWrite || writeLock.current) return false
    writeLock.current = true; setWriting(true); return true
  }
  const endWrite = () => { writeLock.current = false; setWriting(false) }

  const createNote = async (event: FormEvent) => {
    event.preventDefault()
    if (!createTitle.trim() || createUncertain || !beginWrite()) return
    createOperation.current ??= makeOperationId()
    try {
      const created = await getSharedApiClient().createNote({ title: createTitle.trim(), markdown_body: '', ...(folder !== 'all' && folder !== 'unfiled' ? { folder: folder.slice(7) } : {}) }, { idempotencyKey: createOperation.current, queueOnOffline: false })
      setNotes((current) => [...current, created]); setFolder('all'); setSelectedId(created.id); setMobileEditor(true); setFormOpen(false); setCreateTitle(''); createOperation.current = null; setMessage('Note saved.')
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.status !== 408) { createOperation.current = null; setMessage(`${error.code}: ${error.message}`) }
      else { setCreateUncertain(true); setMessage('Creation may have succeeded. Check the notes list before creating another note; reload this view to continue.') }
    } finally { endWrite() }
  }
  const saveNote = async () => {
    if (!selected || !draft || !beginWrite()) return
    const snapshot = draft
    setSavedNotice(null)
    try {
      const saved = await getSharedApiClient().updateNote(selected.id, { title: snapshot.title.trim() || snapshot.base.title, markdown_body: snapshot.body, parent_id: snapshot.base.parent_id, project_id: snapshot.base.project_id, ...(snapshot.base.folder !== undefined || snapshot.folder ? { folder: snapshot.folder.trim() || null } : {}), ...(snapshot.base.tags !== undefined || snapshot.tags.length ? { tags: snapshot.tags } : {}) }, { query: { version: snapshot.base.version }, queueOnOffline: false })
      const organizationAccepted = (saved.folder ?? null) === (snapshot.folder.trim() || null) && JSON.stringify(saved.tags ?? []) === JSON.stringify(snapshot.tags)
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note))
      setDrafts((current) => {
        const next = { ...current }; const existing = next[saved.id]
        if (existing && (!organizationAccepted || existing.title !== snapshot.title || existing.body !== snapshot.body || existing.folder !== snapshot.folder || JSON.stringify(existing.tags) !== JSON.stringify(snapshot.tags))) next[saved.id] = { ...existing, base: saved }
        else delete next[saved.id]
        return next
      })
      setConflictId(null); setLatestConflict(null); setMessage(organizationAccepted ? '' : 'The server did not save folders and tags. Update the server; your draft is preserved.'); setSavedNotice(organizationAccepted ? saved : null)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { setConflictId(selected.id); setLatestConflict(null); setMessage('This note changed on the server. Your draft is preserved.') }
      else setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not save changes. Your draft is preserved; check the server before retrying.')
    }
    finally { endWrite() }
  }

  // Pinning sends the stored note (not the unsaved draft) so a pin never saves half-edited text; the draft keeps its edits on the new base version.
  const togglePin = async () => {
    if (!selected || !beginWrite()) return
    try {
      const saved = await getSharedApiClient().updateNote(selected.id, { title: selected.title, markdown_body: selected.markdown_body, parent_id: selected.parent_id, project_id: selected.project_id, pinned: !selected.pinned, ...(selected.folder !== undefined ? { folder: selected.folder } : {}), ...(selected.tags !== undefined ? { tags: selected.tags } : {}) }, { query: { version: selected.version }, queueOnOffline: false })
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note))
      setDrafts((current) => current[saved.id] ? { ...current, [saved.id]: { ...current[saved.id]!, base: saved } } : current)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { setConflictId(selected.id); setLatestConflict(null); setMessage('This note changed on the server. Your draft is preserved.') }
      else setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not change the pin.')
    }
    finally { endWrite() }
  }
  const deleteNote = async () => {
    if (!selected || !canWrite || writing || !window.confirm(`Delete ${selected.title}? Unsaved changes to this note will be lost.`) || !beginWrite()) return
    try {
      await getSharedApiClient().deleteNote(selected.id, { queueOnOffline: false })
      setNotes((current) => current.filter((note) => note.id !== selected.id))
      setDrafts((current) => { const next = { ...current }; delete next[selected.id]; return next })
      setSelectedId(null); setMobileEditor(false); setMessage('Note deleted.')
    } catch { setMessage('Could not confirm deletion. Your draft is preserved; reload before retrying.') }
    finally { endWrite() }
  }

  const reviewLatest = async () => {
    if (!selected || !beginWrite()) return
    try { setLatestConflict(await getSharedApiClient().note(selected.id)) }
    catch { setMessage('Could not load the latest note. Your draft is preserved.') }
    finally { endWrite() }
  }
  const useLatestVersion = () => {
    if (!selected || !draft || latestConflict?.id !== selected.id) return
    setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draft), base: latestConflict } }))
    setNotes((current) => current.map((note) => note.id === latestConflict.id ? latestConflict : note))
    setConflictId(null); setLatestConflict(null); setMessage('Latest version selected. Your draft is unchanged; save when ready.')
  }
  return { apiStatus, notes, status, query, setQuery, folder, setFolder, tag, setTag, newTag, setNewTag, mobileEditor, setMobileEditor, setSelectedId, drafts, createTitle, setCreateTitle, formOpen, setFormOpen, message, showSavedNotice, writing, conflictId, latestConflict, createUncertain, folders, tags, visible, selected, draft, editDraft, canWrite, compactEditor, load, createNote, saveNote, togglePin, deleteNote, reviewLatest, useLatestVersion }
}
