import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteOut, ProjectResponse } from '@aelys/shared'
import { ArrowLeft, FileText, Search } from '../icons'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './actual-knowledge.css'

function MarkdownText({ text }: { text: string }) {
  return <div className="knowledge-markdown">{text.split('\n').map((line, index) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      if (heading[1].length === 1) return <h2 key={index}>{heading[2]}</h2>
      if (heading[1].length === 2) return <h3 key={index}>{heading[2]}</h3>
      return <h4 key={index}>{heading[2]}</h4>
    }
    return <div key={index}>{line || '\u00a0'}</div>
  })}</div>
}

export function KnowledgeView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
    return notes.filter((note) => !needle || `${note.title} ${note.markdown_body}`.toLowerCase().includes(needle))
  }, [notes, query])
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
  const edit = (id: string) => {
    window.history.pushState({}, '', `/notes?note=${encodeURIComponent(id)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return <div className={`knowledge-view page${reading ? ' knowledge-view--reading' : ''}`}>
    <div className="knowledge-status"><ApiStatusPill status={status} /></div>
    {status !== 'ready' && notes.length === 0 ? <StateCard status={status} title={status === 'loading' ? 'Loading knowledge' : status === 'offline' ? 'Knowledge is offline' : 'Knowledge is unavailable'} description={status === 'loading' ? 'Loading your notes.' : 'Could not load notes. Check your connection and try again.'} action={status === 'loading' ? undefined : <button type="button" className="knowledge-button" onClick={() => void load()}>Try again</button>} /> : <>
      {status !== 'ready' && <div className="knowledge-warning" role="status">{status === 'loading' ? 'Refreshing notes…' : 'Could not refresh notes.'} {status !== 'loading' && <button type="button" className="knowledge-button" onClick={() => void load()}>Try again</button>}</div>}
      <div className="knowledge-grid">
        <section className="knowledge-card knowledge-list" aria-label="Knowledge documents">
          <label className="knowledge-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents" aria-label="Search documents" /></label>
          <div className="knowledge-items">{groups.map(([key, group]) => <div key={key}><h2>{group.label} <span>{group.items.length}</span></h2>{group.items.map((note) => <button type="button" key={note.id} className={`knowledge-item${selected?.id === note.id ? ' knowledge-item--selected' : ''}`} aria-pressed={selected?.id === note.id} onClick={() => { setSelectedId(note.id); setReading(true) }}><span className="knowledge-icon"><FileText size={16} /></span><span className="knowledge-item-text"><strong>{note.title}</strong><small>Note · v{note.version}</small></span></button>)}</div>)}{visible.length === 0 && <p className="knowledge-empty">{notes.length ? 'Nothing found.' : 'No notes yet.'}</p>}</div>
        </section>
        <section className="knowledge-card knowledge-reader" aria-label="Document reader">{selected ? <><div className="knowledge-reader-head"><button type="button" className="knowledge-button knowledge-back" onClick={() => setReading(false)}><ArrowLeft size={16} />Back</button><span className="knowledge-kind">Note · v{selected.version}</span><button type="button" className="knowledge-button knowledge-edit" onClick={() => edit(selected.id)}>Edit note</button></div><article className="knowledge-content"><h1>{selected.title}</h1>{selected.markdown_body ? <MarkdownText text={selected.markdown_body} /> : <p className="knowledge-empty">This note is empty.</p>}</article></> : <div className="knowledge-placeholder">Select a note to read it.</div>}</section>
      </div>
    </>}
  </div>
}
