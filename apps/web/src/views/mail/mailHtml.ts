import DOMPurify from 'dompurify'

const MAX_HTML = 1_000_000
const BLOCKED = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option', 'video', 'audio', 'source', 'track', 'svg', 'math', 'base', 'link', 'meta', 'template']

/** Sanitization plus an opaque sandbox and CSP: mail cannot access the app or fetch by default. */
export function mailDocument(html: string, loadImages = false): { srcDoc: string; remoteImages: number } {
  const clean = DOMPurify.sanitize(html.slice(0, MAX_HTML), {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: BLOCKED,
    FORBID_ATTR: ['srcset', 'ping', 'srcdoc', 'action', 'formaction', 'background', 'autofocus', 'id', 'name'],
    ALLOW_DATA_ATTR: false,
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  let remoteImages = 0
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    let allowed = false
    try {
      const url = new URL(src)
      allowed = url.protocol === 'https:' && !url.username && !url.password
    } catch { /* relative, CID and other schemes stay blocked */ }
    if (allowed) remoteImages += 1
    if (!loadImages || !allowed) img.removeAttribute('src')
    img.setAttribute('referrerpolicy', 'no-referrer')
    img.setAttribute('loading', 'lazy')
    img.setAttribute('decoding', 'async')
  }
  for (const link of doc.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    try {
      const url = new URL(href)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsupported link')
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
    } catch { link.removeAttribute('href'); link.removeAttribute('target') }
  }
  // Keep inline email layout CSS but disallow CSS network features even after image opt-in.
  for (const node of doc.querySelectorAll('[style]')) {
    const style = (node as HTMLElement).style
    for (const property of [...style]) {
      const value = style.getPropertyValue(property)
      if (/url\s*\(|image-set\s*\(|expression\s*\(|@|\\/i.test(value) || /^(behavior|-moz-binding)$/i.test(property)) style.removeProperty(property)
    }
  }
  // Embedded styles can hide content or make network requests; inline table/cell styles remain.
  for (const style of doc.querySelectorAll('style')) style.remove()
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${loadImages ? 'https:' : "'none'"}; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{overflow-wrap:anywhere}body{margin:0;padding:16px;font:14px/1.55 system-ui,sans-serif;color:#202124;background:white}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#4f35cf}</style></head><body>${doc.body.innerHTML}</body></html>`
  return { srcDoc, remoteImages }
}
