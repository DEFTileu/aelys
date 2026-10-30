import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { NoteOut } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { FileText, Folder, Plus, Save, Search } from '../icons'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './actual-projects-notes.css'

const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`

function NotesState({ status, retry }: { status: ApiStatus; retry: () => void }) {
  const copy = status === 'loading' ? ['Loading notes', 'Checking the connected knowledge source.'] : status === 'offline' ? ['Notes are offline', 'Saving notes requires a connection. Unsaved drafts remain in this view.'] : ['Notes are unavailable', 'The notes API did not respond. Check the connection and try again.']
  return <StateCard status={status} title={copy[0]} description={copy[1]} action={<button className="text-button" type="button" onClick={retry}>Try again</button>} />
}

export function NotesView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<'all' | 'unfiled'>('all')
  const [mobileEditor, setMobileEditor] = useState(() => !!new URLSearchParams(window.location.search).get('note'))
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('note'))
  type Draft = { title: string; body: string; base: NoteOut }
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
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return notes.filter((note) => (folder === 'all' || (!note.parent_id && !note.project_id)) && (!needle || `${note.title} ${note.markdown_body}`.toLowerCase().includes(needle))) }, [notes, query, folder])
  const selected = visible.find((note) => note.id === selectedId) ?? visible[0]
  const draft = selected ? drafts[selected.id] ?? { title: selected.title, body: selected.markdown_body, base: selected } : undefined
  const editDraft = (change: Partial<Pick<Draft, 'title' | 'body'>>) => {
    if (!selected || !draft) return
    setDrafts((current) => ({ ...current, [selected.id]: { ...(current[selected.id] ?? draft), ...change } }))
  }
  const canWrite = apiStatus === 'ready' && (typeof navigator === 'undefined' || navigator.onLine)
  const showSavedNotice = !!savedNotice && canWrite && selected?.id === savedNotice.id && draft?.title === savedNotice.title && draft.body === savedNotice.markdown_body
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
      const created = await getSharedApiClient().createNote({ title: createTitle.trim(), markdown_body: '' }, { idempotencyKey: createOperation.current, queueOnOffline: false })
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
      const saved = await getSharedApiClient().updateNote(selected.id, { title: snapshot.title.trim() || snapshot.base.title, markdown_body: snapshot.body, parent_id: snapshot.base.parent_id, project_id: snapshot.base.project_id }, { query: { version: snapshot.base.version }, queueOnOffline: false })
      setNotes((current) => current.map((note) => note.id === saved.id ? saved : note))
      setDrafts((current) => {
        const next = { ...current }; const existing = next[saved.id]
        if (existing && (existing.title !== snapshot.title || existing.body !== snapshot.body)) next[saved.id] = { ...existing, base: saved }
        else delete next[saved.id]
        return next
      })
      setConflictId(null); setLatestConflict(null); setMessage(''); setSavedNotice(saved)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { setConflictId(selected.id); setLatestConflict(null); setMessage('This note changed on the server. Your draft is preserved.') }
      else setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not save changes. Your draft is preserved; check the server before retrying.')
    }
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
    <div className="nl-toolbar"><h1>Notes</h1><ApiStatusPill status={apiStatus} /><label className="nl-search"><Search size={15} color="#625D69" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes…" aria-label="Search notes" /></label><button className="nl-btn nl-btn--primary" type="button" onClick={() => setFormOpen(true)}><Plus size={16} />New note</button></div>
    {formOpen && <form className="nl-form" onSubmit={createNote}><input autoFocus value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Note title" aria-label="New note title" /><button className="nl-btn nl-btn--primary" type="submit" disabled={!canWrite || writing || createUncertain}>Save</button><button className="nl-btn" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {(message || showSavedNotice) && <p className="nl-message" role="status">{message || 'Changes saved.'}</p>}
    {selected && conflictId === selected.id && <div className="nl-form"><button className="nl-btn" type="button" disabled={!canWrite || writing} onClick={() => void reviewLatest()}>Review latest version</button>{latestConflict?.id === selected.id && <div><p>Server title: {latestConflict.title} (v{latestConflict.version})</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{latestConflict.markdown_body}</pre><button className="nl-btn" type="button" onClick={useLatestVersion}>Keep my draft and use this version</button></div>}</div>}
    {status !== 'ready' && notes.length === 0 ? <NotesState status={status} retry={() => void load()} /> : <div className="nl-grid"><section className="nl-card nl-folders"><h2>Folders</h2><button className={`nl-folder ${folder === 'all' ? 'nl-folder--active' : ''}`} type="button" aria-pressed={folder === 'all'} onClick={() => setFolder('all')}><Folder size={16} /><span>All notes</span><small>{notes.length}</small></button><button className={`nl-folder ${folder === 'unfiled' ? 'nl-folder--active' : ''}`} type="button" aria-pressed={folder === 'unfiled'} onClick={() => setFolder('unfiled')}><Folder size={16} /><span>Unfiled</span><small>{notes.filter((note) => !note.parent_id && !note.project_id).length}</small></button></section><section className="nl-card nl-list"><h2>{folder === 'all' ? 'All notes' : 'Unfiled'}</h2><div className="nl-note-list">{visible.map((note) => <button key={note.id} type="button" className={`nl-note ${note.id === selected?.id ? 'nl-note--active' : ''}`} onClick={() => { setSelectedId(note.id); setMobileEditor(true) }}><span className="nl-note-icon"><FileText size={15} /></span><span className="nl-note-body"><span className="nl-note-title"><span>{note.title}</span><small>v{note.version}</small></span><p>{note.markdown_body || 'Empty note'}</p></span></button>)}{visible.length === 0 && <span className="nl-muted">{query ? 'No matching notes.' : 'No notes yet.'}</span>}</div></section><section className="nl-card nl-editor">{selected ? <><div className="nl-editor-head"><button className="nl-back nl-btn" type="button" onClick={() => setMobileEditor(false)}>← All notes</button><FileText size={17} /><span>Note · v{selected.version}</span></div><div className="nl-editor-body"><input value={draft?.title ?? ''} onChange={(event) => editDraft({ title: event.target.value })} aria-label="Note title" /><textarea value={draft?.body ?? ''} onChange={(event) => editDraft({ body: event.target.value })} aria-label="Note body" placeholder="Write in Markdown…" /></div><div className="nl-editor-actions"><button className="nl-btn" type="button" onClick={() => void saveNote()} disabled={!canWrite || writing || conflictId === selected.id}><Save size={15} />Save changes</button></div></> : <StateCard status="empty" title="Select a note" description="Choose a note from the list or create a new one." />}</section></div>}
  </div>
}
