// Markdown <-> sanitized HTML for the rich-text editor. Notes are stored as Markdown; the editor works on a small whitelisted HTML subset.
// shortcut: block-level markdown only covers headings, lists (nested), task lists, quotes, fences and rules; tables, images and html blocks stay literal text.

const ALLOWED = new Set(['p', 'div', 'br', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 's', 'strike', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr'])
// Dropped with their content; every other unknown tag is unwrapped.
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'link', 'meta', 'head', 'title', 'textarea', 'select', 'button', 'input', 'form', 'img', 'audio', 'video', 'canvas', 'frame', 'frameset', 'base'])

/** Links are limited to http(s), mailto and same-origin paths. */
export function safeHref(value: string | null | undefined): string | null {
  const href = (value ?? '').trim()
  // eslint-disable-next-line no-control-regex
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null
  if (/^(https?:|mailto:)/i.test(href)) return href
  return href.startsWith('/') && !href.startsWith('//') ? href : null
}

function copyInto(source: Node, target: Node, doc: Document) {
  source.childNodes.forEach((child) => {
    if (child.nodeType === 3) { target.appendChild(doc.createTextNode(child.textContent ?? '')); return }
    if (child.nodeType !== 1) return
    const el = child as Element, tag = el.tagName.toLowerCase()
    if (DROP.has(tag)) return
    if (!ALLOWED.has(tag)) { copyInto(el, target, doc); return }
    const clean = doc.createElement(tag)
    if (tag === 'a') {
      const href = safeHref(el.getAttribute('href'))
      if (!href) { copyInto(el, target, doc); return }
      clean.setAttribute('href', href); clean.setAttribute('target', '_blank'); clean.setAttribute('rel', 'noopener noreferrer')
    }
    if (tag === 'ul' && el.hasAttribute('data-check')) clean.setAttribute('data-check', '')
    if (tag === 'li' && el.getAttribute('data-done') === '1') clean.setAttribute('data-done', '1')
    copyInto(el, clean, doc)
    target.appendChild(clean)
  })
}

/** Parses untrusted HTML in an inert document and returns only whitelisted tags and attributes. */
export function sanitizeHtml(html: string): string {
  const inert = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  const out = inert.createElement('div')
  copyInto(inert.body, out, inert)
  return out.innerHTML
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---- Markdown -> HTML ----
function inline(text: string): string {
  let out = '', i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpMatchArray | null
    if ((m = rest.match(/^\\([\\`*_{}[\]()#+\-.!~>|<])/))) { out += esc(m[1]); i += 2; continue }
    if ((m = rest.match(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/))) { out += `<code>${esc(m[2].replace(/^ (.*[^ ].*) $/, '$1'))}</code>`; i += m[0].length; continue }
    if ((m = rest.match(/^\[((?:[^[\]\\]|\\.)*)\]\(([^)\s]+)\)/))) {
      const href = safeHref(m[2]); const label = inline(m[1])
      out += href ? `<a href="${esc(href)}">${label}</a>` : label; i += m[0].length; continue
    }
    if ((m = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/))) { out += `<strong>${inline(m[1])}</strong>`; i += m[0].length; continue }
    if ((m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) { out += `<s>${inline(m[1])}</s>`; i += m[0].length; continue }
    if ((m = rest.match(/^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/))) { out += `<em>${inline(m[1])}</em>`; i += m[0].length; continue }
    if ((m = rest.match(/^_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])/)) && !/\w/.test(text[i - 1] ?? '')) { out += `<em>${inline(m[1])}</em>`; i += m[0].length; continue }
    out += esc(text[i]); i += 1
  }
  return out
}

type Item = { ordered: boolean; task: boolean | null; done: boolean; text: string; children: Item[]; indent: number }
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const RULE = /^ {0,3}([-*_])(?: ?\1){2,}\s*$/

function listHtml(items: Item[]): string {
  const ordered = items[0].ordered, check = !ordered && items[0].task !== null
  const body = items.map((item) => `<li${check && item.done ? ' data-done="1"' : ''}>${inline(item.text)}${item.children.length ? listHtml(item.children) : ''}</li>`).join('')
  return `<${ordered ? 'ol' : 'ul'}${check ? ' data-check=""' : ''}>${body}</${ordered ? 'ol' : 'ul'}>`
}

function blocks(lines: string[]): string {
  const out: string[] = []
  const startsBlock = (line: string) => /^```/.test(line) || /^#{1,6}\s/.test(line) || RULE.test(line) || /^\s*>/.test(line) || LIST.test(line)
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    if (/^```/.test(line)) {
      const body: string[] = []; i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i += 1; out.push(`<pre>${esc(body.join('\n'))}</pre>`); continue
    }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(`<h${Math.min(m[1].length, 3)}>${inline(m[2])}</h${Math.min(m[1].length, 3)}>`); i += 1; continue }
    if (RULE.test(line)) { out.push('<hr>'); i += 1; continue }
    if (/^\s*>/.test(line)) {
      const inner: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*> ?/, ''))
      out.push(`<blockquote>${blocks(inner)}</blockquote>`); continue
    }
    if (LIST.test(line)) {
      const roots: Item[] = [], stack: Item[] = []
      while (i < lines.length && (m = lines[i].match(LIST))) {
        const indent = m[1].replace(/\t/g, '  ').length, ordered = /\d/.test(m[2][0])
        const task = !ordered ? m[3].match(/^\[( |x|X)\]\s+(.*)$/) : null
        const item: Item = { ordered, task: task ? true : null, done: !!task && task[1] !== ' ', text: task ? task[2] : m[3], children: [], indent }
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
        if (stack.length) stack[stack.length - 1].children.push(item); else roots.push(item)
        stack.push(item); i += 1
      }
      out.push(listHtml(roots)); continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++])
    out.push(`<p>${para.map((l) => inline(l.trim())).join('<br>')}</p>`)
  }
  return out.join('')
}

export function markdownToHtml(markdown: string): string {
  return sanitizeHtml(blocks((markdown ?? '').replace(/\r\n?/g, '\n').split('\n')))
}

// ---- HTML -> Markdown ----
function escapeText(text: string): string {
  return text.replace(/\u200b/g, '').replace(/\u00a0/g, ' ')
    .replace(/[\\`*[\]]/g, '\\$&').replace(/~~/g, '\\~\\~').replace(/(^|[^\w])_|_(?=[^\w]|$)/g, (m) => m.replace('_', '\\_'))
}
const escapeLineStart = (line: string) => line
  .replace(/^(\s*)(#{1,6}\s|>|[-*+]\s)/, '$1\\$2').replace(/^(\s*\d{1,9})([.)])(\s)/, '$1\\$2$3').replace(/^(\s*)(```)/, '$1\\$2')
  .replace(/^(\s*)([-_]{3,}\s*)$/, '$1\\$2')

function inlineMd(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { out += escapeText(child.textContent ?? ''); return }
    if (child.nodeType !== 1) return
    const el = child as Element, tag = el.tagName.toLowerCase()
    if (tag === 'br') { out += '\n'; return }
    if (tag === 'ul' || tag === 'ol') return
    const content = inlineMd(el)
    if (!content.trim()) { out += content; return }
    const lead = content.match(/^\s*/)![0], trail = content.match(/\s*$/)![0], core = content.trim()
    const wrap = (mark: string) => `${lead}${mark}${core}${mark}${trail}`
    if (tag === 'strong' || tag === 'b') out += wrap('**')
    else if (tag === 'em' || tag === 'i') out += wrap('*')
    else if (tag === 's' || tag === 'strike' || tag === 'del') out += wrap('~~')
    else if (tag === 'code') { const raw = el.textContent ?? ''; const fence = '`'.repeat((Math.max(0, ...(raw.match(/`+/g) ?? []).map((r) => r.length))) + 1); out += fence + (raw.startsWith('`') || raw.endsWith('`') ? ` ${raw} ` : raw) + fence }
    else if (tag === 'a') { const href = safeHref(el.getAttribute('href')); out += href ? `${lead}[${core}](${href.replace(/\)/g, '%29').replace(/\s/g, '%20')})${trail}` : content }
    else out += content
  })
  return out
}

const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 's', 'strike', 'del', 'code', 'a', 'br', 'span'])
function paragraph(nodes: Node[]): string {
  const holder = document.createElement('div')
  nodes.forEach((n) => holder.appendChild(n.cloneNode(true)))
  const text = inlineMd(holder).replace(/\n+$/, '').split('\n').map((l) => escapeLineStart(l.replace(/^[ \t]+(?=\S)/, (s) => s))).join('\n')
  return text.trim()
}

function listMd(list: Element, depth: number): string {
  const ordered = list.tagName.toLowerCase() === 'ol', check = list.hasAttribute('data-check')
  const pad = '  '.repeat(depth)
  let n = 0
  const lines: string[] = []
  list.childNodes.forEach((child) => {
    if (child.nodeType !== 1 || (child as Element).tagName.toLowerCase() !== 'li') return
    const li = child as Element; n += 1
    const marker = ordered ? `${n}. ` : check ? `- [${li.getAttribute('data-done') === '1' ? 'x' : ' '}] ` : '- '
    const text = inlineMd(li).replace(/\n+$/, '').replace(/\n/g, ' ').trim()
    lines.push(`${pad}${marker}${text}`.trimEnd())
    li.childNodes.forEach((sub) => { if (sub.nodeType === 1 && /^(ul|ol)$/i.test((sub as Element).tagName)) lines.push(listMd(sub as Element, depth + 1)) })
  })
  return lines.join('\n')
}

function blocksMd(parent: Node): string[] {
  const out: string[] = []
  let run: Node[] = []
  const flush = () => { if (run.length) { const p = paragraph(run); if (p) out.push(p); run = [] } }
  parent.childNodes.forEach((child) => {
    if (child.nodeType === 3) { run.push(child); return }
    if (child.nodeType !== 1) return
    const el = child as Element, tag = el.tagName.toLowerCase()
    if (INLINE_TAGS.has(tag)) { run.push(el); return }
    flush()
    if (/^h[1-6]$/.test(tag)) { const t = paragraph([...el.childNodes]).replace(/\n/g, ' '); if (t) out.push(`${'#'.repeat(Math.min(Number(tag[1]), 6))} ${t}`) }
    else if (tag === 'ul' || tag === 'ol') { const t = listMd(el, 0); if (t) out.push(t) }
    else if (tag === 'blockquote') { const t = blocksMd(el).join('\n\n'); if (t) out.push(t.split('\n').map((l) => l ? `> ${l}` : '>').join('\n')) }
    else if (tag === 'pre') { const raw = (el.textContent ?? '').replace(/\u200b/g, '').replace(/\n$/, ''); out.push('```\n' + raw + '\n```') }
    else if (tag === 'hr') out.push('---')
    else if (tag === 'p' || tag === 'div') {
      if ([...el.childNodes].some((c) => c.nodeType === 1 && !INLINE_TAGS.has((c as Element).tagName.toLowerCase()))) out.push(...blocksMd(el))
      else { const p = paragraph([...el.childNodes]); if (p) out.push(p) }
    }
  })
  flush()
  return out
}

/** Serialises editor content (an element or an HTML string) to Markdown. The input is sanitized first. */
export function htmlToMarkdown(source: Element | string): string {
  const holder = document.createElement('div')
  holder.innerHTML = sanitizeHtml(typeof source === 'string' ? source : source.innerHTML)
  return blocksMd(holder).join('\n\n')
}
