import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteOut, ProjectResponse } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { useDebouncedQuery, usePagedCollection } from '../../lib/usePagedCollection'
import type { ApiStatus } from '../../types'
import { useDurableDrafts } from '../../lib/durableDrafts'

const ORG_COLORS = ['#14966C', '#D93636', '#D97706', '#2F6FE4', '#0F9488', '#D9367E', '#6A4CF2']
export const orgColor = (name: string) => ORG_COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % ORG_COLORS.length]
// Design wording: "Today, 10:24", "Yesterday", otherwise "Oct 26".
export function noteWhen(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback
  // The API sends UTC instants without a zone suffix; read them as UTC, not local time.
  const date = new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`), now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0 && Math.abs(now.getTime() - date.getTime()) < 60_000) return 'Just now'
  if (days === 0) return `Today, ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export const snippetOf = (body: string) => body.split('\n').map((line) => line.replace(/^\s*(#{1,6}|[-*>])\s+/, '')).join(' ').replace(/\s+/g, ' ').trim() || 'No content yet'
const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`

export function useNotes(apiStatus: ApiStatus) {
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [projectsAvailable, setProjectsAvailable] = useState(false)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('all')
  const [tag, setTag] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const compactEditor = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches === true
  const [mobileEditor, setMobileEditor] = useState(() => !!new URLSearchParams(window.location.search).get('note'))
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('note'))
  type Draft = { projectId?: string | null; title: string; body: string; folder: string; tags: readonly string[]; base: NoteOut }
  const { drafts, setDrafts, status: draftStatus } = useDurableDrafts<Record<string, Draft>>('notes')
  const [createIntent, setCreateIntent] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState('')
  const [savedNotice, setSavedNotice] = useState<Pick<NoteOut, 'id' | 'title' | 'markdown_body'> | null>(null)
  const [writing, setWriting] = useState(false)
  const [conflictId, setConflictId] = useState<string | null>(null)
  const [latestConflict, setLatestConflict] = useState<NoteOut | null>(null)
  const [createUncertain, setCreateUncertain] = useState(false)
  const writeLock = useRef(false)
  const createOperation = useRef<string | null>(null)

  const searchQuery = useDebouncedQuery(query)
  const readPage = useCallback((...args: Parameters<ReturnType<typeof getSharedApiClient>['notesPage']>) => getSharedApiClient().notesPage(...args), [])
  const collection = usePagedCollection(apiStatus, { q: searchQuery, ...(folder !== 'all' ? { folder } : {}), ...(tag ? { tag } : {}) }, readPage)
  const { items: notes, setItems: setNotes } = collection
  const status: ApiStatus = collection.source === 'live' || collection.source === 'cached' ? 'ready' : collection.source === 'loading' ? (apiStatus === 'ready' ? 'loading' : apiStatus) : 'error'
  const load = () => collection.refresh(true)
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => getSharedApiClient().projects()).then(items => { if (active) { setProjects(items); setProjectsAvailable(true) } }).catch(() => { if (active) setProjectsAvailable(false) })
    return () => { active = false }
  }, [apiStatus])
  const [linkedNote, setLinkedNote] = useState<NoteOut | null>(null)
  useEffect(() => {
    if (!selectedId || collection.source !== 'live' || notes.some(note => note.id === selectedId)) return
    let active = true
    void getSharedApiClient().note(selectedId).then(value => { if (active) setLinkedNote(value) }).catch(() => {})
    return () => { active = false }
  }, [selectedId, notes, collection.source])
  useEffect(() => {
    const applyIntent = () => {
      if (window.location.pathname.replace(/\/$/, '') !== '/notes') return
      const params = new URLSearchParams(window.location.search)
      if (params.get('create') === '1') setCreateIntent(true)
      const noteId = params.get('note')
      if (noteId) { setFolder('all'); setTag(null); setQuery(''); setSelectedId(noteId); setMobileEditor(true); setCreateIntent(false) }
    }
    applyIntent()
    window.addEventListener('popstate', applyIntent)
    return () => window.removeEventListener('popstate', applyIntent)
  }, [])
  const folders = useMemo(() => [...new Set([...(collection.facets?.folders ?? []), ...notes.map((note) => note.folder)].filter((value): value is string => !!value))].sort((a, b) => compactEditor ? 0 : a.localeCompare(b)), [notes, compactEditor, collection.facets])
  const tags = useMemo(() => [...new Set([...(collection.facets?.tags ?? []), ...notes.flatMap((note) => note.tags ?? [])])].sort((a, b) => a.localeCompare(b)), [notes, collection.facets])
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return notes.filter((note) => (folder === 'all' || (folder === 'unfiled' ? !note.folder : `folder:${note.folder}` === folder)) && (!tag || (note.tags ?? []).includes(tag)) && (!needle || `${note.title} ${note.markdown_body} ${(note.tags ?? []).join(' ')}`.toLowerCase().includes(needle))) }, [notes, query, folder, tag])
  const selected = visible.find((note) => note.id === selectedId) ?? (collection.source !== 'auth' && linkedNote?.id === selectedId && !query && folder === 'all' && !tag ? linkedNote : visible[0])
  const draft = selected ? drafts[selected.id] ?? { projectId: selected.project_id, title: selected.title, body: selected.markdown_body, folder: selected.folder ?? '', tags: selected.tags ?? [], base: selected } : undefined
  const editDraft = (change: Partial<Pick<Draft, 'title' | 'body' | 'folder' | 'tags' | 'projectId'>>) => {
    if (!selected || !draft) return
    setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draft), ...change } }))
  }
  const canWrite = apiStatus === 'ready' && collection.source === 'live' && !collection.refreshing && (typeof navigator === 'undefined' || navigator.onLine)
  const showSavedNotice = !!savedNotice && canWrite && selected?.id === savedNotice.id && draft?.title === savedNotice.title && draft.body === savedNotice.markdown_body && draft.folder === (selected?.folder ?? '') && JSON.stringify(draft.tags) === JSON.stringify(selected?.tags ?? []) && (draft.projectId === undefined ? draft.base.project_id : draft.projectId) === selected?.project_id
  useEffect(() => { if (savedNotice && !showSavedNotice) setSavedNotice(null) }, [savedNotice, showSavedNotice])
  const beginWrite = () => {
    if (!canWrite || writeLock.current) return false
    writeLock.current = true; setWriting(true); return true
  }
  const endWrite = () => { writeLock.current = false; setWriting(false) }

  // As in the design, New note adds an empty "Untitled" note at the top of the list, selects it and focuses the title.
  const newNote = async () => {
    if (createUncertain) return
    if (!beginWrite()) { if (!canWrite) setMessage('OFFLINE_WRITE_UNAVAILABLE: Connect before creating a note.'); return }
    createOperation.current ??= makeOperationId()
    try {
      const inFolder = folder.startsWith('folder:') ? folder.slice(7) : undefined
      const created = await getSharedApiClient().createNote({ title: '', markdown_body: '', ...(inFolder ? { folder: inFolder } : {}), ...(tag ? { tags: [tag] } : {}) }, { idempotencyKey: createOperation.current, queueOnOffline: false })
      setNotes((current) => [created, ...current]); setQuery(''); setSelectedId(created.id); setMobileEditor(true); createOperation.current = null; setMessage('')
      window.setTimeout(() => titleInput.current?.focus(), 60)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.status !== 408) { createOperation.current = null; setMessage(`${error.code}: ${error.message}`) }
      else { setCreateUncertain(true); setMessage('Creation may have succeeded. Check the notes list before creating another note; reload this view to continue.') }
    } finally { endWrite() }
  }
  useEffect(() => { if (createIntent && canWrite) { setCreateIntent(false); void newNote() } }, [createIntent, canWrite])
  const saveNote = async () => {
    if (!selected || !draft || !beginWrite()) return
    const snapshot = draft
    setSavedNotice(null)
    try {
      const saved = await getSharedApiClient().updateNote(selected.id, { title: snapshot.title.trim() || snapshot.base.title, markdown_body: snapshot.body, parent_id: snapshot.base.parent_id, project_id: snapshot.projectId === undefined ? snapshot.base.project_id : snapshot.projectId, knowledge_enabled: snapshot.base.knowledge_enabled ?? false, ...(snapshot.base.folder !== undefined || snapshot.folder ? { folder: snapshot.folder.trim() || null } : {}), ...(snapshot.base.tags !== undefined || snapshot.tags.length ? { tags: snapshot.tags } : {}) }, { query: { version: snapshot.base.version }, queueOnOffline: false })
      const organizationAccepted = (saved.folder ?? null) === (snapshot.folder.trim() || null) && JSON.stringify(saved.tags ?? []) === JSON.stringify(snapshot.tags)
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note))
      setDrafts((current) => {
        const next = { ...current }; const existing = next[saved.id]
        if (existing && (!organizationAccepted || existing.title !== snapshot.title || existing.body !== snapshot.body || existing.folder !== snapshot.folder || existing.projectId !== snapshot.projectId || JSON.stringify(existing.tags) !== JSON.stringify(snapshot.tags))) next[saved.id] = { ...existing, base: saved }
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
    if (!selected || !canWrite || writing || !window.confirm(`Delete ${selected.title || 'Untitled'}? Unsaved changes to this note will be lost.`) || !beginWrite()) return
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
    try { setLatestConflict(await getSharedApiClient().note(selected.id, { forceRefresh: true, allowCacheFallback: false })) }
    catch { setMessage('Could not load the latest note. Your draft is preserved.') }
    finally { endWrite() }
  }
  const useLatestVersion = () => {
    if (!selected || !draft || latestConflict?.id !== selected.id) return
    setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draft), base: latestConflict } }))
    setNotes((current) => current.map((note) => note.id === latestConflict.id ? latestConflict : note))
    setConflictId(null); setLatestConflict(null); setMessage('Latest version selected. Your draft is unchanged; save when ready.')
  }
  return { projects, projectsAvailable, query, setQuery, folder, setFolder, tag, setTag, newTag, setNewTag, compactEditor, mobileEditor, setMobileEditor, selected, setSelectedId, tags, draft, drafts, status, draftStatus, notes, titleInput, message, writing, conflictId, latestConflict, collection, load, folders, visible, editDraft, canWrite, showSavedNotice, newNote, saveNote, togglePin, deleteNote, reviewLatest, useLatestVersion }
}
