import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteOut, ProjectResponse } from '@aelys/shared'
import { ArrowLeft, FileText, Search } from '../icons'
import { askAelys } from '../lib/desktopStore'
import { projectColor } from './tasks/taskModel'
import './desktop/page-tokens.css'
import { PageSkeleton } from '../components/PageSkeleton'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './actual-knowledge.css'
import './desktop/knowledge.css'
import { MarkdownContent } from '../components/MarkdownContent'

const updatedLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function KnowledgeView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [managing, setManaging] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [question, setQuestion] = useState('')
  const [askScope, setAskScope] = useState('document')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('note'))
  const [reading, setReading] = useState(false)
  const requestSequence = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestSequence.current
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try {
      const result = await getSharedApiClient().notes()
      if (request !== requestSequence.current) return
      setNotes(result)
      void Promise.resolve().then(() => getSharedApiClient().projects()).then((value) => { if (request === requestSequence.current) setProjects(value) }).catch(() => { if (request === requestSequence.current) setProjects([]) })
      setSelectedId((current) => result.some((note) => note.id === current) ? current : result[0]?.id ?? null)
      setStatus('ready')
    } catch {
      if (request !== requestSequence.current) return
      setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
    }
  }, [apiStatus])
  useEffect(() => { void load(); return () => { requestSequence.current += 1 } }, [load])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return notes.filter((note) => (managing || note.knowledge_enabled) && (!projectId || note.project_id === projectId) && (!needle || `${note.title} ${note.markdown_body}`.toLowerCase().includes(needle)))
  }, [notes, query, managing, projectId])
  const groups = useMemo(() => {
    const parents = new Map(notes.map((note) => [note.id, note.title]))
    const projectNames = new Map(projects.map((project) => [project.id, project.name]))
    const result = new Map<string, { label: string; items: NoteOut[] }>()
    for (const note of visible) {
      const parent = note.parent_id && parents.get(note.parent_id)
      const project = note.project_id && projectNames.get(note.project_id)
      const key = parent ? `parent:${note.parent_id}` : project ? `project:${note.project_id}` : 'documents'
      const group = result.get(key) ?? { label: parent || project || 'Documents', items: [] }
      group.items.push(note); result.set(key, group)
    }
    return [...result.entries()]
  }, [notes, visible, projects])
  const selected = visible.find((note) => note.id === selectedId) ?? visible[0]
  const selectedGroup = groups.find(([, group]) => group.items.some((note) => note.id === selected?.id))?.[0] ?? 'documents'
  const toggleSource = async (note: NoteOut) => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      const saved = await getSharedApiClient().updateNote(note.id, { title: note.title, markdown_body: note.markdown_body, project_id: note.project_id, parent_id: note.parent_id, folder: note.folder, tags: note.tags, knowledge_enabled: !note.knowledge_enabled }, { query: { version: note.version }, queueOnOffline: false })
      setNotes(current => current.map(item => item.id === saved.id ? saved : item))
      setNotice(saved.knowledge_enabled ? 'Source enabled. Questions may send excerpts to your selected AI provider.' : 'Source removed from future AI retrieval. Previous chat answers are retained.')
    } catch { setNotice('Could not update the source. Refresh before retrying; it may have changed elsewhere.') }
    finally { setBusy(false) }
  }
  const edit = (id: string) => {
    window.history.pushState({}, '', `/notes?note=${encodeURIComponent(id)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return <div className={`knowledge-view page${reading ? ' knowledge-view--reading' : ''}`}>
    <div className="knowledge-status"><button className="knowledge-button" type="button" aria-pressed={managing} onClick={() => setManaging(!managing)}>{managing ? 'Show library' : 'Manage sources'}</button><button className="knowledge-button" type="button" onClick={() => { window.history.pushState({}, '', '/notes?create=1'); window.dispatchEvent(new PopStateEvent('popstate')) }}>New document</button><label>Project <select aria-label="Knowledge project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
    <p className="knowledge-warning">Only enabled sources are available to AI. Asking a question sends relevant excerpts to the selected provider. Agent transcripts are excluded.</p>
    {notice && <p role="status">{notice}</p>}
    {status !== 'ready' && notes.length === 0 ? <PageSkeleton kind="split" label="knowledge base" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} /> : <>
      {status !== 'ready' && <div className="knowledge-warning" role="status">{status === 'loading' ? 'Refreshing notes…' : 'Could not refresh notes.'} {status !== 'loading' && <button type="button" className="knowledge-button" onClick={() => void load()}>Try again</button>}</div>}
      <div className="knowledge-grid">
        <section className="knowledge-card knowledge-list" aria-label="Knowledge documents">
          <label className="knowledge-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents" aria-label="Search documents" /></label>
          <div className="knowledge-items">{groups.map(([key, group]) => <div key={key}><h2>{group.label}</h2>{group.items.map((note) => <button type="button" key={note.id} className={`knowledge-item${selected?.id === note.id ? ' knowledge-item--selected' : ''}`} aria-pressed={selected?.id === note.id} onClick={() => { setSelectedId(note.id); setReading(true) }}><span className="knowledge-icon" style={{ color: projectColor(key), background: `${projectColor(key)}1A` }}><FileText size={16} /></span><span className="knowledge-item-text"><strong>{note.title}</strong><small>Note · {note.knowledge_enabled ? 'AI enabled' : 'AI disabled'}</small></span></button>)}</div>)}{visible.length === 0 && <p className="knowledge-empty">{notes.length ? 'No enabled sources match. Use Manage sources to add notes.' : 'No notes yet.'}</p>}</div>
        </section>
        <section className="knowledge-card knowledge-reader" aria-label="Document reader">{selected ? <><div className="knowledge-reader-head"><button type="button" className="knowledge-button knowledge-back" onClick={() => setReading(false)}><ArrowLeft size={16} />Back</button><span className="knowledge-kind" style={{ color: projectColor(selectedGroup), background: `${projectColor(selectedGroup)}1A` }}>{groups.find(([, group]) => group.items.some(note => note.id === selected.id))?.[1].label ?? 'Documents'}</span><span className="knowledge-updated">{selected.updated_at ? `Updated ${updatedLabel(selected.updated_at)}` : ''}</span><button type="button" className="knowledge-button" disabled={busy || apiStatus !== 'ready'} onClick={() => void toggleSource(selected)}>{selected.knowledge_enabled ? 'Disable for AI' : 'Enable for AI'}</button><button type="button" className="knowledge-button knowledge-edit" onClick={() => edit(selected.id)}>Edit note</button></div><article className="knowledge-content"><h1>{selected.title}</h1>{selected.markdown_body ? <MarkdownContent text={selected.markdown_body} /> : <p className="knowledge-empty">This note is empty.</p>}</article>{selected.knowledge_enabled && <form className="knowledge-ask" onSubmit={event => { event.preventDefault(); if (question.trim()) askAelys(question.trim(), askScope === 'document' ? { note_ids: [selected.id] } : projectId ? { project_id: projectId } : {}) }}>
          <label>Ask about<select aria-label="Question scope" value={askScope} onChange={event => setAskScope(event.target.value)}><option value="document">This document</option><option value="library">{projectId ? 'Selected project' : 'Enabled library'}</option></select></label>
          <input aria-label="Question about knowledge" value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask Aelys about these sources…" required maxLength={4000} />
          <button type="submit" className="knowledge-button" disabled={apiStatus !== 'ready'}>Ask Aelys</button></form>}</> : <div className="knowledge-placeholder">Select a note to read it.</div>}</section>
      </div>
    </>}
  </div>
}
