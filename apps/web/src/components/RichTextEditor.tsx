import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { X } from '../icons'
import { htmlToMarkdown, markdownToHtml, safeHref, sanitizeHtml } from '../lib/richText'
import { LucideGlyph, type LucideName } from './LucideGlyph'
import '../views/desktop/page-tokens.css'
import './rich-text.css'

type Active = Partial<Record<'bold' | 'italic' | 'strike' | 'h1' | 'h2' | 'ul' | 'ol' | 'check' | 'quote' | 'code' | 'pre' | 'link', boolean>>
type Tool = { id: string; icon: LucideName; label: string; title: string; run: () => void }

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const wordsOf = (text: string) => (text.match(/\S+/g) ?? []).length
// jsdom has no innerText; browsers use it so block boundaries count as spaces.
const textOf = (el: HTMLElement) => (el as HTMLElement & { innerText?: string }).innerText ?? el.textContent ?? ''

/**
 * Design AelysRichText as a React component. `value` and `onChange` are Markdown; the editor itself holds a sanitized HTML subset
 * and converts on load/emit. `docKey` marks a different document: the editor reloads only when the key changes and the content differs.
 */
export function RichTextEditor({ value, docKey, onChange, placeholder = 'Start writing…', minHeight = '240px', compact = false, footer = true, label = 'Text' }: {
  value: string; docKey?: string; onChange?: (markdown: string, text: string) => void; placeholder?: string; minHeight?: string; compact?: boolean; footer?: boolean; label?: string
}) {
  const ref = useRef<HTMLDivElement>(null), linkRef = useRef<HTMLInputElement>(null)
  const saved = useRef<Range | null>(null), lastMarkdown = useRef<string | null>(null)
  const latest = useRef({ onChange, value }); latest.current = { onChange, value }
  const [act, setAct] = useState<Active>({})
  const [empty, setEmpty] = useState(true), [words, setWords] = useState(0)
  const [linkOpen, setLinkOpen] = useState(false), [linkUrl, setLinkUrl] = useState(''), [hasLink, setHasLink] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current; if (!el) return ''
    const text = textOf(el)
    setEmpty(!text.trim() && !el.querySelector('li,hr'))
    setWords(wordsOf(text))
    return text
  }, [])
  const emit = useCallback(() => {
    const el = ref.current; if (!el) return
    const text = measure(); const markdown = htmlToMarkdown(el)
    lastMarkdown.current = markdown
    latest.current.onChange?.(markdown, text)
  }, [measure])
  const load = useCallback(() => {
    const el = ref.current; if (!el) return
    const incoming = latest.current.value ?? ''
    // Same document, same text (e.g. after a save): keep the caret and the formatting the user sees.
    if (lastMarkdown.current !== null && lastMarkdown.current === incoming) return
    el.innerHTML = markdownToHtml(incoming)
    lastMarkdown.current = htmlToMarkdown(el); measure()
  }, [measure])
  useEffect(() => { lastMarkdown.current = null; load() }, [docKey, load])
  useEffect(() => { if (document.activeElement !== ref.current) load() }, [value, load])

  const inside = () => { const s = window.getSelection(); return !!(s && s.rangeCount && ref.current?.contains(s.anchorNode)) }
  const up = (tag: string, attr?: string): Element | null => {
    const s = window.getSelection(); if (!s?.rangeCount) return null
    let n: Node | null = s.anchorNode
    while (n && n !== ref.current) { if (n.nodeName === tag && (!attr || (n as Element).hasAttribute(attr))) return n as Element; n = n.parentNode }
    return null
  }
  const sync = useCallback(() => {
    if (!inside()) return
    const q = (c: string) => { try { return document.queryCommandState(c) } catch { return false } }
    const chk = !!up('UL', 'data-check')
    const next: Active = { bold: q('bold'), italic: q('italic'), strike: q('strikeThrough'), h1: !!up('H1'), h2: !!up('H2'), ul: !!up('UL') && !chk, ol: !!up('OL'), check: chk, quote: !!up('BLOCKQUOTE'), code: !!up('CODE') && !up('PRE'), pre: !!up('PRE'), link: !!up('A') }
    setAct((cur) => JSON.stringify(cur) === JSON.stringify(next) ? cur : next)
  }, [])
  useEffect(() => { document.addEventListener('selectionchange', sync); return () => document.removeEventListener('selectionchange', sync) }, [sync])

  const focus = () => {
    const el = ref.current; if (!el || inside()) return
    el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
    const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r)
  }
  const cmd = (name: string, val?: string) => { focus(); document.execCommand?.(name, false, val); emit(); sync() }
  const block = (tag: string) => { focus(); const on = !!up(tag.toUpperCase()); document.execCommand?.('formatBlock', false, on ? '<p>' : `<${tag}>`); emit(); sync() }
  const list = (kind: 'ul' | 'ol' | 'check') => {
    focus(); const chk = up('UL', 'data-check')
    if (kind === 'check') { if (chk) document.execCommand?.('insertUnorderedList'); else { if (!up('UL')) document.execCommand?.('insertUnorderedList'); up('UL')?.setAttribute('data-check', '') } }
    else if (kind === 'ul' && chk) { chk.removeAttribute('data-check'); chk.querySelectorAll('li[data-done]').forEach((li) => li.removeAttribute('data-done')) }
    else document.execCommand?.(kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList')
    emit(); sync()
  }
  const inlineCode = () => {
    focus(); const c = up('CODE')
    if (c) { c.replaceWith(document.createTextNode(c.textContent ?? '')); emit(); sync(); return }
    const txt = window.getSelection()?.toString() || 'code'
    document.execCommand?.('insertHTML', false, `<code>${escHtml(txt)}</code>&#8203;`); emit(); sync()
  }
  const openLink = () => {
    const s = window.getSelection(); saved.current = s?.rangeCount && inside() ? s.getRangeAt(0).cloneRange() : null
    const a = up('A'); setLinkUrl(a?.getAttribute('href') ?? ''); setHasLink(!!a); setLinkOpen(true)
  }
  useEffect(() => { if (linkOpen) linkRef.current?.focus() }, [linkOpen])
  const restore = () => { ref.current?.focus(); if (saved.current) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(saved.current) } }
  const applyLink = () => {
    let u = linkUrl.trim(); if (!u) { setLinkOpen(false); return }
    if (!/^(https?:|mailto:|\/)/i.test(u)) u = `https://${u}`
    const href = safeHref(u); if (!href) { setLinkOpen(false); return }
    restore(); const s = window.getSelection()
    if (s?.isCollapsed && !up('A')) document.execCommand?.('insertHTML', false, `<a href="${escHtml(href)}">${escHtml(href.replace(/^https?:\/\//, ''))}</a>&nbsp;`)
    else document.execCommand?.('createLink', false, href)
    ref.current?.querySelectorAll('a').forEach((a) => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') })
    setLinkOpen(false); emit()
  }

  // Markdown shortcuts: "# ", "## ", "> ", "``` ", "- ", "* ", "1. ", "[] " typed at the start of a block.
  const shortcut = (e: KeyboardEvent): boolean => {
    const s = window.getSelection(); if (!s?.rangeCount || !s.isCollapsed) return false
    const n = s.anchorNode; if (!n || n.nodeType !== 3) return false
    const before = (n.textContent ?? '').slice(0, s.anchorOffset)
    const map: Record<string, ['block' | 'list', string]> = { '#': ['block', 'h1'], '##': ['block', 'h2'], '>': ['block', 'blockquote'], '```': ['block', 'pre'], '-': ['list', 'ul'], '*': ['list', 'ul'], '1.': ['list', 'ol'], '[]': ['list', 'check'], '[ ]': ['list', 'check'] }
    const hit = Object.hasOwn(map, before) ? map[before] : undefined; if (!hit) return false
    const p = n.parentNode as Element; const blocks = ['P', 'DIV', 'H1', 'H2', 'LI', 'BLOCKQUOTE']
    if (p !== ref.current && !blocks.includes(p.nodeName)) return false
    if (n.previousSibling) return false
    if (p.nodeName === 'LI' && hit[0] === 'list') return false
    e.preventDefault()
    n.textContent = (n.textContent ?? '').slice(s.anchorOffset)
    const r = document.createRange(); r.setStart(n, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r)
    if (hit[0] === 'block') block(hit[1]); else list(hit[1] as 'ul' | 'ol' | 'check')
    if (!n.textContent) { const li = up('LI') ?? up(hit[1].toUpperCase()); if (li && !li.innerHTML) li.innerHTML = '<br>' }
    return true
  }

  const T: (Tool | 0)[] = [
    { id: 'h1', icon: 'heading-1', label: 'Heading', title: 'Heading', run: () => block('h1') }, { id: 'h2', icon: 'heading-2', label: 'Subheading', title: 'Subheading', run: () => block('h2') }, 0,
    { id: 'bold', icon: 'bold', label: 'Bold', title: 'Bold  ⌘B', run: () => cmd('bold') }, { id: 'italic', icon: 'italic', label: 'Italic', title: 'Italic  ⌘I', run: () => cmd('italic') },
    { id: 'strike', icon: 'strikethrough', label: 'Strikethrough', title: 'Strikethrough', run: () => cmd('strikeThrough') }, { id: 'code', icon: 'code', label: 'Inline code', title: 'Inline code', run: inlineCode },
    { id: 'link', icon: 'link', label: 'Link', title: 'Link', run: openLink }, 0,
    { id: 'ul', icon: 'list', label: 'Bulleted list', title: 'Bulleted list', run: () => list('ul') }, { id: 'ol', icon: 'list-ordered', label: 'Numbered list', title: 'Numbered list', run: () => list('ol') },
    { id: 'check', icon: 'list-checks', label: 'Checklist', title: 'Checklist', run: () => list('check') }, 0,
    { id: 'quote', icon: 'quote', label: 'Quote', title: 'Quote', run: () => block('blockquote') }, { id: 'pre', icon: 'square-code', label: 'Code block', title: 'Code block', run: () => block('pre') },
    { id: 'hr', icon: 'minus', label: 'Divider', title: 'Divider', run: () => cmd('insertHorizontalRule') },
  ]
  const tools = T.filter((t) => !(compact && t && ['pre', 'hr', 'strike'].includes(t.id)))

  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ' && shortcut(e)) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); openLink(); return }
    if (e.key === 'Tab' && up('LI')) { e.preventDefault(); cmd(e.shiftKey ? 'outdent' : 'indent') }
    e.stopPropagation()
  }
  const onDown = (e: MouseEvent) => {
    const li = (e.target as Element).closest?.('li')
    if (li?.parentElement?.hasAttribute('data-check') && e.clientX - li.getBoundingClientRect().left < 24) {
      e.preventDefault(); if (li.getAttribute('data-done') === '1') li.removeAttribute('data-done'); else li.setAttribute('data-done', '1'); emit()
    }
  }
  const fs = compact ? 16 : 15
  return <div className="rte">
    <div className={`rte__toolbar${compact ? ' rte__toolbar--compact' : ''}`} role="toolbar" aria-label="Formatting">
      {tools.map((t, i) => t === 0 ? <span key={i} className="rte__sep" aria-hidden="true" />
        : <button key={t.id} type="button" className="rte__tool" aria-label={t.label} title={t.title} aria-pressed={!!act[t.id as keyof Active]} data-on={act[t.id as keyof Active] ? '1' : undefined} onMouseDown={(e) => { e.preventDefault(); t.run() }}><LucideGlyph name={t.icon} /></button>)}
    </div>
    {linkOpen && <div className="rte__link">
      <LucideGlyph name="link" />
      <input ref={linkRef} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } if (e.key === 'Escape') { setLinkOpen(false); restore() } }} placeholder="Paste a link" aria-label="Link address" />
      <button type="button" className="rte__apply" onMouseDown={(e) => { e.preventDefault(); applyLink() }}>Apply</button>
      {hasLink && <button type="button" className="rte__remove" onMouseDown={(e) => { e.preventDefault(); restore(); const a = up('A'); if (a) a.replaceWith(...Array.from(a.childNodes)); setLinkOpen(false); emit() }}>Remove</button>}
      <button type="button" className="rte__close" aria-label="Cancel" onMouseDown={(e) => { e.preventDefault(); setLinkOpen(false); restore() }}><X size={16} /></button>
    </div>}
    <div className="rte__body" style={{ minHeight }}>
      {empty && <div className="rte__placeholder" aria-hidden="true" style={{ fontSize: fs }}>{placeholder}</div>}
      <div ref={ref} className="rte__content" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label} spellCheck
        style={{ minHeight, fontSize: fs }} onInput={() => {
          ref.current?.querySelectorAll('ul[data-check] > li[data-done="1"]').forEach((li) => { if (!li.textContent?.trim() && li.previousElementSibling) li.removeAttribute('data-done') })
          emit()
        }} onKeyDown={onKey} onMouseDown={onDown}
        onPaste={(e) => {
          const t = e.clipboardData?.getData('text/plain'); if (t == null) return
          e.preventDefault()
          // Pasted text is parsed as Markdown and sanitized; rich clipboard HTML is never inserted.
          const html = markdownToHtml(t).replace(/<h[123]>/g, '<p>').replace(/<\/h[123]>/g, '</p>')
          document.execCommand?.('insertHTML', false, sanitizeHtml(html) || escHtml(t)); emit()
        }} />
    </div>
    {footer && <div className="rte__footer"><span>{words} words</span><span className="rte__grow" />{!compact && <span>Type <b>#</b> heading · <b>-</b> list · <b>[]</b> checklist · <b>&gt;</b> quote</span>}</div>}
  </div>
}
