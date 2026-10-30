import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { NoteOut } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { FileText, Folder, Plus, Save, Search } from '../icons'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`

function NotesState({ status, retry }: { status: ApiStatus; retry: () => void }) {
  const copy = status === 'loading' ? ['Loading notes', 'Checking the connected knowledge source.'] : status === 'offline' ? ['Notes are offline', 'Saving notes requires a connection. Unsaved drafts remain in this view.'] : ['Notes are unavailable', 'The notes API did not respond. Check the connection and try again.']
  return <StateCard status={status} title={copy[0]} description={copy[1]} action={<button className="text-button" type="button" onClick={retry}>Try again</button>} />
}

export function NotesView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return needle ? notes.filter((note) => `${note.title} ${note.markdown_body}`.toLowerCase().includes(needle)) : notes }, [notes, query])
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
      setNotes((current) => [...current, created]); setSelectedId(created.id); setFormOpen(false); setCreateTitle(''); createOperation.current = null; setMessage('Note saved.')
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

  return <div className="notes-live page">
    <style>{`
      .notes-live { padding:0 28px 32px; color:#1C1B22; }.notes-live * { box-sizing:border-box; }.nl-toolbar { display:flex; align-items:center; gap:10px; padding:20px 0 16px; }.nl-toolbar h1 { flex:1; margin:0; font:600 22px/30px Inter,-apple-system,sans-serif; }.nl-search { width:260px; height:36px; display:flex; align-items:center; gap:8px; padding:0 10px; border:1px solid #E7E2DE; border-radius:10px; background:#fff; }.nl-search input { min-width:0; flex:1; border:0; outline:0; font-size:13px; }.nl-btn { height:36px; display:inline-flex; align-items:center; gap:7px; padding:0 12px; border:1px solid #E7E2DE; border-radius:10px; background:#fff; cursor:pointer; }.nl-btn--primary { border:0; color:#fff; background:#6A4CF2; }.nl-message { margin:0 0 12px; color:#128A63; font-size:12px; }.nl-form { display:flex; gap:8px; margin-bottom:14px; padding:10px; border:1px solid #ECE7E3; border-radius:14px; background:rgba(255,255,255,.8); }.nl-form input { min-width:0; flex:1; height:36px; padding:0 10px; border:1px solid #E7E2DE; border-radius:9px; outline:0; }
      .nl-grid { display:grid; grid-template-columns:220px 300px minmax(0,1fr); gap:16px; min-height:640px; }.nl-card { min-width:0; overflow:hidden; padding:16px 12px; border:1px solid rgba(255,255,255,.35); border-radius:20px; background:rgba(255,255,255,.88); box-shadow:0 8px 24px rgba(40,30,30,.07); backdrop-filter:blur(20px); }.nl-card h2 { margin:0 8px 12px; font-size:16px; line-height:24px; }.nl-folder { width:100%; height:40px; display:flex; align-items:center; gap:10px; padding:0 10px; border:0; border-radius:10px; color:#3A3640; background:transparent; cursor:pointer; text-align:left; }.nl-folder--active { color:#5132D6; background:#EEEAFD; }.nl-folder span { flex:1; }.nl-note-list { display:grid; gap:4px; }.nl-note { display:flex; gap:10px; width:100%; padding:10px; border:0; border-radius:12px; background:transparent; cursor:pointer; text-align:left; }.nl-note--active { background:#EEEAFD; }.nl-note-icon { width:30px; height:30px; display:grid; flex:none; place-items:center; border-radius:8px; color:#6A4CF2; background:#EEE8FD; }.nl-note-body { min-width:0; flex:1; }.nl-note-title { display:flex; gap:8px; font-size:13px; font-weight:600; }.nl-note-title span:first-child { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.nl-note-body p { overflow:hidden; display:-webkit-box; margin:3px 0 0; color:#625D69; font-size:11px; line-height:16px; -webkit-line-clamp:2; -webkit-box-orient:vertical; }.nl-editor { display:flex; flex-direction:column; padding:0; }.nl-editor-head { display:flex; align-items:center; gap:10px; height:52px; padding:0 16px; border-bottom:1px solid #EFEAE6; }.nl-editor-head input { min-width:0; flex:1; border:0; outline:0; font:700 22px/30px Inter,-apple-system,sans-serif; }.nl-editor-body { min-height:0; flex:1; padding:18px 22px; }.nl-editor-body textarea { width:100%; min-height:430px; resize:vertical; border:0; outline:0; color:#3A3640; background:transparent; font:14px/1.65 Inter,-apple-system,sans-serif; }.nl-editor-actions { display:flex; justify-content:flex-end; gap:8px; padding:12px 16px; border-top:1px solid #EFEAE6; }.nl-muted { color:#625D69; font-size:12px; }
      .notes-live .nl-toolbar h1 { display:none; }.notes-live .nl-search { margin-left:auto; }
      @media (max-width:950px) { .nl-grid { grid-template-columns:190px minmax(0,1fr); }.nl-editor { grid-column:1/-1; min-height:500px; }.nl-search { width:200px; } } @media (max-width:700px) { .notes-live { padding-inline:2px; }.nl-toolbar { flex-wrap:wrap; }.nl-toolbar h1 { display:none; }.nl-search { width:auto; flex:1; margin-left:0; }.nl-grid { grid-template-columns:1fr; }.nl-editor { grid-column:auto; }.nl-card { min-height:0; } }
    `}</style>
    <div className="nl-toolbar"><h1>Notes</h1><ApiStatusPill status={apiStatus} /><label className="nl-search"><Search size={15} color="#625D69" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes…" aria-label="Search notes" /></label><button className="nl-btn nl-btn--primary" type="button" onClick={() => setFormOpen(true)}><Plus size={16} />New note</button></div>
    {formOpen && <form className="nl-form" onSubmit={createNote}><input autoFocus value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Note title" aria-label="New note title" /><button className="nl-btn nl-btn--primary" type="submit" disabled={!canWrite || writing || createUncertain}>Save</button><button className="nl-btn" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {(message || showSavedNotice) && <p className="nl-message" role="status">{message || 'Changes saved.'}</p>}
    {selected && conflictId === selected.id && <div className="nl-form"><button className="nl-btn" type="button" disabled={!canWrite || writing} onClick={() => void reviewLatest()}>Review latest version</button>{latestConflict?.id === selected.id && <div><p>Server title: {latestConflict.title} (v{latestConflict.version})</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{latestConflict.markdown_body}</pre><button className="nl-btn" type="button" onClick={useLatestVersion}>Keep my draft and use this version</button></div>}</div>}
    {status !== 'ready' && notes.length === 0 ? <NotesState status={status} retry={() => void load()} /> : <div className="nl-grid"><section className="nl-card"><h2>Folders</h2><button className="nl-folder nl-folder--active" type="button"><Folder size={16} /><span>All notes</span><small>{notes.length}</small></button><button className="nl-folder" type="button"><Folder size={16} /><span>Unfiled</span></button></section><section className="nl-card"><h2>All notes</h2><div className="nl-note-list">{visible.map((note) => <button key={note.id} type="button" className={`nl-note ${note.id === selected?.id ? 'nl-note--active' : ''}`} onClick={() => setSelectedId(note.id)}><span className="nl-note-icon"><FileText size={15} /></span><span className="nl-note-body"><span className="nl-note-title"><span>{note.title}</span><small>v{note.version}</small></span><p>{note.markdown_body || 'Empty note'}</p></span></button>)}{visible.length === 0 && <span className="nl-muted">{query ? 'No matching notes.' : 'No notes yet.'}</span>}</div></section><section className="nl-card nl-editor">{selected ? <><div className="nl-editor-head"><FileText size={19} color="#D97706" /><input value={draft?.title ?? ''} onChange={(event) => editDraft({ title: event.target.value })} aria-label="Note title" /></div><div className="nl-editor-body"><textarea value={draft?.body ?? ''} onChange={(event) => editDraft({ body: event.target.value })} aria-label="Note body" placeholder="Write in Markdown…" /></div><div className="nl-editor-actions"><button className="nl-btn" type="button" onClick={() => void saveNote()} disabled={!canWrite || writing || conflictId === selected.id}><Save size={15} />Save changes</button></div></> : <StateCard status="empty" title="Select a note" description="Choose a note from the list or create a new one." />}</section></div>}
  </div>
}
