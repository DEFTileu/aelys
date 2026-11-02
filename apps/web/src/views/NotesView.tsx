import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteOut, ProjectResponse } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { Check, FileText, Folder, Plus, Save, Search, SquarePen, Trash2, X } from '../icons'
import './desktop/page-tokens.css'
import { RichTextEditor } from '../components/RichTextEditor'
import { PageSkeleton } from '../components/PageSkeleton'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './actual-projects-notes.css'
import './desktop/notes.css'
import { useDurableDrafts } from '../lib/durableDrafts'
import { MobileHeader } from '../components/MobileHeader'

const ORG_COLORS = ['#14966C', '#D93636', '#D97706', '#2F6FE4', '#0F9488', '#D9367E', '#6A4CF2']
const orgColor = (name: string) => ORG_COLORS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % ORG_COLORS.length]
// Design wording: "Today, 10:24", "Yesterday", otherwise "Oct 26".
function noteWhen(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback
  // The API sends UTC instants without a zone suffix; read them as UTC, not local time.
  const date = new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`), now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0 && Math.abs(now.getTime() - date.getTime()) < 60_000) return 'Just now'
  if (days === 0) return `Today, ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const snippetOf = (body: string) => body.split('\n').map((line) => line.replace(/^\s*(#{1,6}|[-*>])\s+/, '')).join(' ').replace(/\s+/g, ' ').trim() || 'No content yet'
const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`

function NotesState({ status, retry }: { status: ApiStatus; retry: () => void }) {
  return <PageSkeleton kind="split" label="notes" phase={status === 'loading' ? 'loading' : 'error'} onRetry={retry} />
}

export function NotesView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [projectsAvailable, setProjectsAvailable] = useState(false)
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
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

  const load = async () => {
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try {
      const value = await getSharedApiClient().notes()
      void Promise.resolve().then(() => getSharedApiClient().projects()).then(items => { setProjects(items); setProjectsAvailable(true) }).catch(() => setProjectsAvailable(false))
      setNotes(value); setSelectedId((current) => current ?? value[0]?.id ?? null); setStatus('ready')
    } catch { setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error') }
  }
  useEffect(() => { void load() }, [apiStatus])
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
  const folders = useMemo(() => [...new Set(notes.map((note) => note.folder).filter((value): value is string => !!value))].sort((a, b) => compactEditor ? 0 : a.localeCompare(b)), [notes, compactEditor])
  const tags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags ?? []))].sort((a, b) => a.localeCompare(b)), [notes])
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return notes.filter((note) => (folder === 'all' || (folder === 'unfiled' ? !note.folder : `folder:${note.folder}` === folder)) && (!tag || (note.tags ?? []).includes(tag)) && (!needle || `${note.title} ${note.markdown_body} ${(note.tags ?? []).join(' ')}`.toLowerCase().includes(needle))) }, [notes, query, folder, tag])
  const selected = visible.find((note) => note.id === selectedId) ?? visible[0]
  const draft = selected ? drafts[selected.id] ?? { projectId: selected.project_id, title: selected.title, body: selected.markdown_body, folder: selected.folder ?? '', tags: selected.tags ?? [], base: selected } : undefined
  const editDraft = (change: Partial<Pick<Draft, 'title' | 'body' | 'folder' | 'tags' | 'projectId'>>) => {
    if (!selected || !draft) return
    setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draft), ...change } }))
  }
  const canWrite = apiStatus === 'ready' && (typeof navigator === 'undefined' || navigator.onLine)
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
  useEffect(() => { if (createIntent && status === 'ready') { setCreateIntent(false); void newNote() } }, [createIntent, status])
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

  return <div className={`notes-live page${mobileEditor ? ' notes-live--editing' : ''}`} >
    <MobileHeader sub={mobileEditor ? undefined : `${notes.length} notes`} action={mobileEditor ? undefined : <button type="button" onClick={() => void newNote()}><SquarePen size={16} />New</button>} />
    <div className="nl-toolbar"><h1>Notes</h1>{status !== 'ready' && notes.length === 0 && <button className="nl-btn nl-btn--primary" type="button" onClick={() => void newNote()}><Plus size={16} />New note</button>}</div>
    {(message || showSavedNotice) && <p className="nl-message" role="status">{message || 'Changes saved.'}</p>}
    {selected && conflictId === selected.id && <div className="nl-form"><button className="nl-btn" type="button" disabled={!canWrite || writing} onClick={() => void reviewLatest()}>Review latest version</button>{latestConflict?.id === selected.id && <div><p>Server title: {latestConflict.title} (v{latestConflict.version})</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{latestConflict.markdown_body}</pre><button className="nl-btn" type="button" onClick={useLatestVersion}>Keep my draft and use this version</button></div>}</div>}
    {status !== 'ready' && notes.length === 0 ? <NotesState status={status} retry={() => void load()} /> : <div className="nl-grid"><section className="nl-card nl-folders"><button className="nl-btn nl-btn--primary nl-new" type="button" onClick={() => void newNote()}><SquarePen size={16} />New note</button><h2>Folders</h2><button className={`nl-folder ${folder === 'all' ? 'nl-folder--active' : ''}`} type="button" aria-pressed={folder === 'all'} onClick={() => setFolder('all')}><FileText size={16} /><span>{compactEditor ? 'All' : 'All notes'}</span><small>{notes.length}</small></button>{notes.some((note) => !note.folder) && <button className={`nl-folder ${folder === 'unfiled' ? 'nl-folder--active' : ''}`} type="button" aria-pressed={folder === 'unfiled'} onClick={() => setFolder('unfiled')}><Folder size={16} style={{ color: folder === 'unfiled' ? undefined : '#4F4A56' }} /><span>Unfiled</span><small>{notes.filter((note) => !note.folder).length}</small></button>}{folders.map((name) => <button className={`nl-folder ${folder === `folder:${name}` ? 'nl-folder--active' : ''}`} key={name} type="button" aria-pressed={folder === `folder:${name}`} onClick={() => setFolder(`folder:${name}`)}><Folder size={16} style={{ color: folder === `folder:${name}` ? undefined : orgColor(name) }} /><span>{name}</span><small>{notes.filter((note) => note.folder === name).length}</small></button>)}{tags.length > 0 && <><h2 className="nl-tags-title">Tags</h2><div className="nl-tags">{tags.map((name) => <button key={name} type="button" aria-pressed={tag === name} style={{ color: orgColor(name), background: `${orgColor(name)}1A` }} onClick={() => setTag(tag === name ? null : name)}>#{name}<small>{notes.filter((note) => (note.tags ?? []).includes(name)).length}</small></button>)}</div></>}</section><section className="nl-card nl-list"><button className="nl-btn nl-btn--primary nl-new-compact" type="button" onClick={() => void newNote()}><SquarePen size={15} />New note</button><label className="nl-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" aria-label="Search notes" /></label><div className="nl-list-head"><h2>{folder === 'all' ? 'All notes' : folder === 'unfiled' ? 'Unfiled' : folder.slice(7)}</h2><span>{visible.length}</span></div><div className="nl-note-list">{visible.map((note) => <button key={note.id} type="button" className={`nl-note ${note.id === selected?.id ? 'nl-note--active' : ''}`} onClick={() => { setSelectedId(note.id); setMobileEditor(true) }}><span className="nl-note-body"><span className="nl-note-title"><span>{note.title || 'Untitled'}</span><small>{noteWhen(note.updated_at, '')}</small></span><p>{snippetOf(note.markdown_body)}</p><span className="nl-note-tags">{note.tags?.map((name) => <span key={name}>#{name}</span>)}</span></span></button>)}{visible.length === 0 && <span className="nl-muted">{query ? 'No matching notes.' : 'No notes match. Try another folder or search.'}</span>}</div></section><section className="nl-card nl-editor">{selected ? <><div className="nl-editor-head"><button className="nl-back nl-btn" type="button" onClick={() => setMobileEditor(false)}>← All notes</button><Folder size={16} className="nl-head-folder" /><input className="nl-folder-input" value={draft?.folder ?? ''} maxLength={120} list="nl-folder-options" onChange={(event) => editDraft({ folder: event.target.value })} placeholder="Unfiled" aria-label="Note folder" /><datalist id="nl-folder-options">{folders.map((name) => <option value={name} key={name} />)}</datalist><span className="nl-grow" /><span className="nl-saved">{drafts[selected.id] ? 'Unsaved changes' : <><Check size={14} />Saved{selected.updated_at ? ` · ${noteWhen(selected.updated_at, '')}` : ''}</>}</span><button className="nl-pin" type="button" onClick={() => void togglePin()} disabled={!canWrite || writing} aria-pressed={!!selected.pinned}>{selected.pinned ? 'Unpin' : 'Pin'}</button><button className="nl-delete" type="button" onClick={() => void deleteNote()} disabled={!canWrite || writing} aria-label="Delete note" title="Delete note"><Trash2 size={17} /></button></div><div className="nl-editor-body">{new URLSearchParams(window.location.search).get('version') && Number(new URLSearchParams(window.location.search).get('version')) !== selected.version && <p role="status">The AI source refers to version {new URLSearchParams(window.location.search).get('version')}. You are reading the current version {selected.version}; the quoted excerpt remains in the chat.</p>}<input ref={titleInput} className="nl-title-input" value={draft?.title ?? ''} onChange={(event) => editDraft({ title: event.target.value })} placeholder="Untitled" aria-label="Note title" /><div className="nl-organization"><label>Project<select aria-label="Note project" value={(draft?.projectId === undefined ? draft?.base.project_id : draft.projectId) ?? ''} disabled={!projectsAvailable} onChange={event => editDraft({ projectId: event.target.value || null })}><option value="">No project</option>{draft?.base.project_id && !projects.some(project => project.id === draft.base.project_id) && <option value={draft.base.project_id}>Current project</option>}{projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div><div className="nl-tag-editor"><div className="nl-tags nl-tags--edit">{draft?.tags.map((name) => <button key={name} type="button" onClick={() => editDraft({ tags: draft.tags.filter((value) => value !== name) })} aria-label={`Remove tag ${name}`}>#{name}<X size={12} /></button>)}</div><div className="nl-tag-add"><input value={newTag} maxLength={80} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); const name = newTag.trim().replace(/^#/, '').trim(); if (name && draft && !draft.tags.includes(name)) editDraft({ tags: [...draft.tags, name] }); setNewTag('') } }} placeholder="+ Add tag" aria-label="New tag" /><button type="button" className="nl-sr" onClick={() => { const name = newTag.trim().replace(/^#/, '').trim(); if (name && draft && !draft.tags.includes(name)) editDraft({ tags: [...draft.tags, name] }); setNewTag('') }}>Add</button></div></div><RichTextEditor value={draft?.body ?? ''} docKey={selected.id} onChange={(markdown) => editDraft({ body: markdown })} placeholder="Start writing… Type # for a heading, [] for a checklist" minHeight="360px" label="Note body" footer={false} compact={compactEditor} /></div><p role="status" className="nl-message">{draftStatus}</p><div className="nl-editor-actions"><span>{draft?.body.trim() ? draft.body.trim().split(/\s+/).length : 0} words</span><button className="nl-btn nl-save" type="button" onClick={() => void saveNote()} disabled={!canWrite || writing || conflictId === selected.id}><Save size={14} />Save changes</button></div></> : <div className="nl-none"><SquarePen size={32} />Select a note or create a new one</div>}</section></div>}
  </div>
}
