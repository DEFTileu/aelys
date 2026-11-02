import { ApiStatusPill } from '../../components/ApiStatusPill'
import { PageSkeleton } from '../../components/PageSkeleton'
import { RichTextEditor } from '../../components/RichTextEditor'
import { ArrowLeft, Check, Folder, Plus, Save, Search, Trash2, X } from '../../icons'
import type { ApiStatus } from '../../types'
import './notes-mobile.css'
import { noteWhen, snippetOf, useNotes } from './useNotes'

// One screen at a time: the list, or the editor which replaces it until Back.
export function NotesMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const { notes, status, query, setQuery, folder, setFolder, tag, setTag, newTag, setNewTag, mobileEditor, setMobileEditor, setSelectedId, drafts, createTitle, setCreateTitle, formOpen, setFormOpen, message, showSavedNotice, writing, conflictId, latestConflict, createUncertain, folders, tags, visible, selected, draft, editDraft, canWrite, load, createNote, saveNote, togglePin, deleteNote, reviewLatest, useLatestVersion } = useNotes(apiStatus)

  const addTag = () => {
    const name = newTag.trim().replace(/^#/, '').trim()
    if (name && draft && !draft.tags.includes(name)) editDraft({ tags: [...draft.tags, name] })
    setNewTag('')
  }

  return <div className="notes-m">
    {!(mobileEditor && selected) ? <>
      <div className="notes-m-head"><h1>Notes</h1><ApiStatusPill status={apiStatus} /></div>
      <label className="notes-m-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" aria-label="Search notes" /></label>
      <div className="notes-m-chips" role="group" aria-label="Folders">
        <button type="button" aria-pressed={folder === 'all'} onClick={() => setFolder('all')}>All</button>
        {notes.some((note) => !note.folder) && <button type="button" aria-pressed={folder === 'unfiled'} onClick={() => setFolder('unfiled')}>Unfiled</button>}
        {folders.map((name) => <button type="button" key={name} aria-pressed={folder === `folder:${name}`} onClick={() => setFolder(`folder:${name}`)}>{name}</button>)}
      </div>
      {tags.length > 0 && <div className="notes-m-chips" role="group" aria-label="Tags">{tags.map((name) => <button type="button" key={name} aria-pressed={tag === name} onClick={() => setTag(tag === name ? null : name)}>#{name}</button>)}</div>}
      {(message || showSavedNotice) && <p className="notes-m-message" role="status">{message || 'Changes saved.'}</p>}
      {status !== 'ready' && notes.length === 0 ? <PageSkeleton kind="list" label="notes" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} /> : <div className="notes-m-list">
        {visible.map((note) => <button type="button" key={note.id} className="notes-m-card" onClick={() => { setSelectedId(note.id); setMobileEditor(true) }}>
          <span className="notes-m-card-title"><span>{note.title || 'Untitled'}</span><small>{noteWhen(note.updated_at, `v${note.version}`)}</small></span>
          <span className="notes-m-snippet">{snippetOf(note.markdown_body)}</span>
          {(note.tags ?? []).length > 0 && <span className="notes-m-tags">{note.tags?.map((name) => <span key={name}>#{name}</span>)}</span>}
        </button>)}
        {visible.length === 0 && <p className="notes-m-empty">{query ? 'No matching notes.' : 'No notes found.'}</p>}
      </div>}
      <button className="notes-m-fab" type="button" aria-label="New note" onClick={() => setFormOpen(true)}><Plus size={24} /></button>
      {formOpen && <>
        <div className="notes-m-scrim" onClick={() => setFormOpen(false)} />
        <form className="notes-m-sheet" role="dialog" aria-label="New note" onSubmit={createNote}>
          <h2>New note</h2>
          <input autoFocus value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Note title" aria-label="New note title" />
          <div className="notes-m-sheet-actions"><button type="button" onClick={() => setFormOpen(false)}>Cancel</button><button className="notes-m-primary" type="submit" disabled={!canWrite || writing || createUncertain || !createTitle.trim()}>Save</button></div>
        </form>
      </>}
    </> : selected && <section className="notes-m-editor">
      {(message || showSavedNotice) && <p className="notes-m-message" role="status">{message || 'Changes saved.'}</p>}
      <div className="notes-m-bar">
        <button type="button" className="notes-m-back" onClick={() => setMobileEditor(false)}><ArrowLeft size={18} />Notes</button>
        <span className="notes-m-grow" />
        <button type="button" className="notes-m-text" onClick={() => void togglePin()} disabled={!canWrite || writing} aria-pressed={!!selected.pinned}>{selected.pinned ? 'Unpin' : 'Pin'}</button>
        <button type="button" className="notes-m-icon" onClick={() => void deleteNote()} disabled={!canWrite || writing} aria-label="Delete note" title="Delete note"><Trash2 size={18} /></button>
      </div>
      <div className="notes-m-meta"><label className="notes-m-field"><Folder size={15} /><input value={draft?.folder ?? ''} maxLength={120} list="notes-m-folder-options" onChange={(event) => editDraft({ folder: event.target.value })} placeholder="Unfiled" aria-label="Note folder" /></label><datalist id="notes-m-folder-options">{folders.map((name) => <option value={name} key={name} />)}</datalist><span>{drafts[selected.id] ? 'Unsaved changes' : <><Check size={14} />Saved · {noteWhen(selected.updated_at, `v${selected.version}`)}</>}</span></div>
      <input className="notes-m-title" value={draft?.title ?? ''} onChange={(event) => editDraft({ title: event.target.value })} placeholder="Untitled" aria-label="Note title" />
      <div className="notes-m-tags-edit">{draft?.tags.map((name) => <button type="button" key={name} onClick={() => editDraft({ tags: draft.tags.filter((value) => value !== name) })} aria-label={`Remove tag ${name}`}>#{name}<X size={12} /></button>)}
        <input value={newTag} maxLength={80} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag() } }} placeholder="+ Add tag" aria-label="New tag" /></div>
      {conflictId === selected.id && <div className="notes-m-conflict"><button type="button" disabled={!canWrite || writing} onClick={() => void reviewLatest()}>Review latest version</button>{latestConflict?.id === selected.id && <div><p>Server title: {latestConflict.title} (v{latestConflict.version})</p><pre>{latestConflict.markdown_body}</pre><button type="button" onClick={useLatestVersion}>Keep my draft and use this version</button></div>}</div>}
      <RichTextEditor value={draft?.body ?? ''} docKey={selected.id} onChange={(markdown) => editDraft({ body: markdown })} placeholder="Start writing…" minHeight="360px" label="Note body" footer={false} compact />
      <div className="notes-m-actions"><span>{draft?.body.trim() ? draft.body.trim().split(/\s+/).length : 0} words</span><button className="notes-m-primary" type="button" onClick={() => void saveNote()} disabled={!canWrite || writing || conflictId === selected.id}><Save size={16} />Save changes</button></div>
    </section>}
  </div>
}
