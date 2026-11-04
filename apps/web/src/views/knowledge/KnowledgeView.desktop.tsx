import { askAelys } from '../../lib/desktopStore'
import { ArrowLeft, FileText, Search } from '../../icons'
import { projectColor } from '../tasks/taskModel'
import '../desktop/page-tokens.css'
import { PageSkeleton } from '../../components/PageSkeleton'
import type { ApiStatus } from '../../types'
import '../actual-knowledge.css'
import '../desktop/knowledge.css'
import { MarkdownContent } from '../../components/MarkdownContent'
import { updatedLabel, useKnowledge } from './useKnowledge'

export function KnowledgeDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const { reading, managing, setManaging, projectId, setProjectId, projects, notice, status, notes, load, query, setQuery, groups, selected, setSelectedId, setReading, visible, selectedGroup, busy, toggleSource, edit, askScope, setAskScope, question, setQuestion } = useKnowledge(apiStatus)

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
