import { ArrowLeft, FileText, Search, Sparkles } from '../../icons'
import { askAelys } from '../../lib/desktopStore'
import { projectColor } from '../tasks/taskModel'
import type { KnowledgeHook } from './useKnowledge'

export function MarkdownText({ text }: { text: string }) {
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

export const updatedLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function KnowledgeList({ t }: { t: KnowledgeHook }) {
  const { notes, query, setQuery, setSelectedId, setReading, visible, groups, selected } = t
  return (
    <section className="knowledge-card knowledge-list" aria-label="Knowledge documents">
          <label className="knowledge-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents" aria-label="Search documents" /></label>
          <div className="knowledge-items">{groups.map(([key, group]) => <div key={key}><h2>{group.label}</h2>{group.items.map((note) => <button type="button" key={note.id} className={`knowledge-item${selected?.id === note.id ? ' knowledge-item--selected' : ''}`} aria-pressed={selected?.id === note.id} onClick={() => { setSelectedId(note.id); setReading(true) }}><span className="knowledge-icon" style={{ color: projectColor(key), background: `${projectColor(key)}1A` }}><FileText size={16} /></span><span className="knowledge-item-text"><strong>{note.title}</strong><small>{note.updated_at ? `Updated ${updatedLabel(note.updated_at)}` : `Note · v${note.version}`}</small></span></button>)}</div>)}{visible.length === 0 && <p className="knowledge-empty">{notes.length ? 'Nothing found.' : 'No notes yet.'}</p>}</div>
        </section>
  )
}

export function KnowledgeReader({ t }: { t: KnowledgeHook }) {
  const { setReading, groups, selected, selectedGroup, edit } = t
  return (
    <section className="knowledge-card knowledge-reader" aria-label="Document reader">{selected ? <><div className="knowledge-reader-head"><button type="button" className="knowledge-button knowledge-back" onClick={() => setReading(false)}><ArrowLeft size={16} />Back</button><span className="knowledge-kind" style={{ color: projectColor(selectedGroup), background: `${projectColor(selectedGroup)}1A` }}>{groups.find(([, group]) => group.items.some((note) => note.id === selected.id))?.[1].label ?? 'Documents'}</span><span className="knowledge-updated">{selected.updated_at ? `Updated ${updatedLabel(selected.updated_at)}` : `Version ${selected.version}`}</span><span className="knowledge-grow" /><button type="button" className="knowledge-button" onClick={() => askAelys(`Tell me about my note "${selected.title}".`)}><Sparkles size={15} />Ask Aelys about this</button><button type="button" className="knowledge-button knowledge-edit" onClick={() => edit(selected.id)}>Edit note</button></div><article className="knowledge-content"><h1>{selected.title}</h1>{selected.markdown_body ? <MarkdownText text={selected.markdown_body} /> : <p className="knowledge-empty">This note is empty.</p>}</article></> : <div className="knowledge-placeholder">Select a note to read it.</div>}</section>
  )
}
