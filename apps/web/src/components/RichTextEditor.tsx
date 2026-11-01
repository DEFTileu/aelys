import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { LucideGlyph, type LucideName } from './LucideGlyph'
import '../views/desktop/page-tokens.css'
import './rich-text.css'

type Props = { value: string; onChange?: (value: string, text: string) => void; label?: string; disabled?: boolean; compact?: boolean; docKey?: string; placeholder?: string; minHeight?: string; footer?: boolean }

export function RichTextEditor({ value, onChange, label = 'Text', disabled = false, compact = false, docKey, placeholder = 'Start writing…', minHeight = compact ? '120px' : '240px', footer = true }: Props) {
  const [source, setSource] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const safeLink = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(linkUrl.trim())
  const [, redraw] = useState(0)
  const change = useRef(onChange)
  const emitted = useRef(value)
  change.current = onChange
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false } }), Markdown, TaskList, TaskItem.configure({ nested: true }), TableKit],
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    editorProps: { attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'true', class: 'rte__content', 'data-placeholder': placeholder, style: `min-height:${minHeight}` } },
    onUpdate: ({ editor: current }) => { emitted.current = current.getMarkdown(); change.current?.(emitted.current, current.getText()) },
    onTransaction: () => redraw(v => v + 1),
  })
  useEffect(() => {
    if (editor && value !== emitted.current) {
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
      emitted.current = value
    }
  }, [editor, value])
  useEffect(() => { setSource(false) }, [docKey])
  useEffect(() => { editor?.setEditable(!disabled, false) }, [editor, disabled])
  if (!editor) return <textarea aria-label={label} value={value} onChange={e => onChange?.(e.target.value, e.target.value)} disabled={disabled} />
  const icons: Record<string, LucideName> = { Bold: 'bold', Italic: 'italic', Heading: 'heading-2', List: 'list', Checklist: 'list-checks', Code: 'square-code', Quote: 'quote', Table: 'table', Strikethrough: 'strikethrough', 'Inline code': 'code', 'Numbered list': 'list-ordered', Divider: 'minus' }
  const commands = [
    { label: 'Strikethrough', active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: 'Inline code', active: editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
    { label: 'Numbered list', active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: 'Divider', active: false, run: () => editor.chain().focus().setHorizontalRule().run() },
    { label: 'Bold', active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italic', active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Heading', active: editor.isActive('heading'), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'List', active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Checklist', active: editor.isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run() },
    { label: 'Code', active: editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run() },
    ...(!compact ? [{ label: 'Quote', active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
      { label: 'Table', active: false, run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }] : []),
  ]
  return <div className={`rte rich-text${compact ? ' rich-text--compact' : ''}`}>
    <div className={`rte__toolbar${compact ? ' rte__toolbar--compact' : ''}`} role="toolbar" aria-label={`${label} formatting`}>
      {commands.map(command => <button key={command.label} className="rte__tool" aria-label={command.label} title={command.label} data-on={command.active ? '1' : undefined} type="button" disabled={disabled || source} aria-pressed={command.active} onMouseDown={e => e.preventDefault()} onClick={command.run}><LucideGlyph name={icons[command.label]} /></button>)}
      <button type="button" disabled={disabled || source} className="rte__tool" aria-label="Link" title="Link" aria-expanded={linkOpen} onMouseDown={e => e.preventDefault()} onClick={() => { setLinkUrl(String(editor.getAttributes('link').href ?? '')); setLinkOpen(!linkOpen) }}><LucideGlyph name="link" /></button>
      <button type="button" aria-pressed={source} onClick={() => setSource(!source)}>{source ? 'Rich text' : 'Markdown'}</button>
    </div>
    {linkOpen && <div className="rich-text__link" role="group" aria-label="Insert link"><input aria-label="Link address" value={linkUrl} placeholder="https://…" onChange={event => setLinkUrl(event.target.value)} /><button type="button" disabled={disabled || source || !safeLink} onClick={() => { editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl.trim() }).run(); setLinkOpen(false) }}>Apply link</button><button type="button" disabled={disabled || source} onClick={() => { editor.chain().focus().unsetLink().run(); setLinkOpen(false) }}>Remove link</button></div>}
    {source ? <textarea aria-label={label} value={value} disabled={disabled} onChange={e => onChange?.(e.target.value, e.target.value)} /> : <EditorContent editor={editor} />}
    {footer && <div className="rte__footer">{editor.getText().match(/\S+/g)?.length ?? 0} words</div>}
  </div>
}
