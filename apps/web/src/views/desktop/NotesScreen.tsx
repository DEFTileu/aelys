import { useState, type CSSProperties } from 'react'
import { ArrowDownUp, Calendar, Check, Folder, Lightbulb, Mountain, Plus, Sparkles, SquareCheck, Target } from 'lucide-react'
import { ScreenToolbar } from '../../components/ScreenToolbar'
import { askAelys } from '../../lib/desktopStore'
import { EDITOR_TOOLS, KEY_IDEAS, NOTE_DOC, NOTE_FOLDERS, NOTE_TAGS, NOTES, NOTES_TOOLBAR, REFERENCE_IMAGE, REFERENCE_POSITIONS, noteTone, type NoteColor } from '../../data/desktop/notes'
import './notes.css'

const glass: CSSProperties = {
  borderRadius: 20,
  background: 'var(--glass-bg, rgba(255,255,255,.88))',
  border: '1px solid rgba(255,255,255,.35)',
  boxShadow: '0 8px 24px rgba(40,30,30,.07)',
}

const tagChip = (color: NoteColor): CSSProperties => ({ background: noteTone(color).soft, color: noteTone(color).c })

export function NotesScreen() {
  const [selectedNote, setSelectedNote] = useState(0)
  const [ideas, setIdeas] = useState<Record<number, boolean>>({})
  const toggleIdea = (index: number) => setIdeas((current) => ({ ...current, [index]: !current[index] }))

  return <>
    <ScreenToolbar placeholder={NOTES_TOOLBAR.placeholder} primary={NOTES_TOOLBAR.primary} onAsk={askAelys} />

    <div className="notes-grid" style={{ padding: '0 28px', display: 'grid', gridTemplateColumns: '220px 300px minmax(0,1fr)', gap: 16, height: 816 }}>
      <section aria-label="Folders" data-glass="" style={{ ...glass, padding: '16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', marginBottom: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px', flex: 1 }}>Folders</span>
          <button type="button" className="notes-btn notes-icon-btn" aria-label="New folder" title="New folder" style={{ width: 32, height: 32, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={18} /></button>
        </div>
        {NOTE_FOLDERS.map(({ title, count, icon: Icon, color, active }) => <button key={title} type="button" className="notes-btn" aria-current={active ? 'true' : undefined} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, height: 40, padding: '0 10px', borderRadius: 12, fontSize: 14, fontWeight: 500, background: active ? '#EEEAFD' : 'transparent', color: active ? '#5132D6' : '#1C1B22' }}>
          <Icon size={18} color={color} />
          <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
          <span style={{ fontSize: 12, color: '#625D69' }}>{count}</span>
        </button>)}
        <div style={{ height: 1, background: '#ECE6E2', margin: '12px 8px' }} />
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', marginBottom: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px', flex: 1 }}>Tags</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 8px' }}>
          {NOTE_TAGS.map(({ name, count, color }) => <button key={name} type="button" className="notes-btn" style={{ height: 28, padding: '0 10px', borderRadius: 14, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, ...tagChip(color) }}>
            #{name}<span style={{ color: '#4F4A56' }}>{count}</span>
          </button>)}
        </div>
      </section>

      <section aria-label="All notes" data-glass="" style={{ ...glass, padding: '16px 12px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', marginBottom: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px', flex: 1 }}>All notes</span>
          <button type="button" className="notes-btn notes-icon-btn" aria-label="Sort" title="Sort" style={{ width: 32, height: 32, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ArrowDownUp size={16} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NOTES.map((note, index) => {
            const tone = noteTone(note.color)
            const Icon = note.icon
            const selected = index === selectedNote
            return <button key={note.title} type="button" className="notes-btn" aria-current={selected ? 'true' : undefined} onClick={() => setSelectedNote(index)} style={{ display: 'flex', gap: 12, padding: 12, borderRadius: 14, background: selected ? '#EEEAFD' : 'transparent' }}>
              <span style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: tone.soft, color: tone.c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={16} /></span>
              <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
                <span style={{ display: 'flex', gap: 6, fontSize: 14, lineHeight: '20px', fontWeight: 600 }}>
                  <span style={{ flex: 1 }}>{note.title}</span>
                  <span style={{ fontSize: 12, fontWeight: 400, color: '#625D69' }}>{note.when}</span>
                </span>
                <span style={{ display: '-webkit-box', fontSize: 13, lineHeight: '18px', color: '#625D69', margin: '2px 0 8px', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{note.summary}</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  {note.tags.map((tag) => <span key={tag.name} style={{ height: 22, lineHeight: '22px', padding: '0 8px', borderRadius: 7, fontSize: 12, ...tagChip(tag.color) }}>#{tag.name}</span>)}
                </span>
              </span>
            </button>
          })}
        </div>
      </section>

      <section aria-label="Note editor" data-glass="" style={{ ...glass, borderRadius: 20, background: 'rgba(255,255,255,.92)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div role="toolbar" aria-label="Formatting" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 12px', height: 52, borderBottom: '1px solid #EFEAE6', fontSize: 13, fontWeight: 600 }}>
          {EDITOR_TOOLS.map((tool, index) => tool === 'separator'
            ? <span key={`sep-${index}`} aria-hidden="true" style={{ width: 1, height: 20, background: '#E6E0DC', margin: '0 6px' }} />
            : <button key={tool.title} type="button" className="notes-btn notes-icon-btn" title={tool.title} aria-label={tool.title} style={{ minWidth: 32, height: 32, padding: '0 6px', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {tool.icon && <tool.icon size={18} />}{tool.label}
            </button>)}
        </div>

        <div style={{ padding: '20px 24px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Lightbulb size={28} color="#E08A12" />
            <span style={{ fontSize: 30, lineHeight: '38px', fontWeight: 700, letterSpacing: '-0.02em' }}>{NOTE_DOC.title}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 13, lineHeight: '18px', color: '#625D69' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Folder size={14} />{NOTE_DOC.folder}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Calendar size={14} />{NOTE_DOC.updated}</span>
            {NOTE_DOC.tags.map((tag) => <span key={tag} style={{ height: 22, lineHeight: '22px', padding: '0 8px', borderRadius: 7, background: '#EEE8FD', color: '#5132D6', fontSize: 12 }}>#{tag}</span>)}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, fontSize: 16, fontWeight: 600, lineHeight: '24px' }}><Target size={18} color="#E5484D" />Goal</div>
          <div style={{ margin: '4px 0 0 28px', color: '#3A3640' }}>{NOTE_DOC.goal}</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 16, fontWeight: 600, lineHeight: '24px' }}><Mountain size={18} color="#3B82F6" />Inspiration</div>
          <ul style={{ margin: '4px 0 0 28px', paddingLeft: 18, color: '#3A3640' }}>
            {NOTE_DOC.inspiration.map((item) => <li key={item}>{item}</li>)}
          </ul>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 16, fontWeight: 600, lineHeight: '24px' }}><SquareCheck size={18} color="#1FB58A" />Key ideas</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '4px 0 0 28px', color: '#3A3640' }}>
            {KEY_IDEAS.map((idea, index) => {
              const done = !!ideas[index]
              return <button key={idea} type="button" role="checkbox" aria-checked={done} className="notes-btn" onClick={() => toggleIdea(index)} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 26, cursor: 'pointer' }}>
                <span style={{ width: 18, height: 18, flex: 'none', borderRadius: '50%', border: done ? 'none' : '1.5px solid #8E8894', background: done ? '#14966C' : 'transparent', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>{done && <Check size={11} />}</span>
                <span style={{ textDecoration: done ? 'line-through' : 'none', color: done ? '#625D69' : '#3A3640' }}>{idea}</span>
              </button>
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 16, fontWeight: 600, lineHeight: '24px' }}><Sparkles size={18} color="#E08A12" />References</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 8 }}>
            {REFERENCE_POSITIONS.map((position) => <div key={position} role="img" aria-label="Reference" style={{ height: 84, borderRadius: 12, background: `url("${REFERENCE_IMAGE}") ${position} / auto 220px` }} />)}
          </div>
        </div>
      </section>
    </div>
  </>
}
