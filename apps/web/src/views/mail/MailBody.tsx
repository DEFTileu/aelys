import { useEffect, useMemo, useState } from 'react'
import type { MailMessage } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { mailDocument } from './mailHtml'

/** Load only the opened message; the shared client caches detail reads on this device. */
export function MailBody({ message, offline }: { message: MailMessage; offline: boolean }) {
  const [detail, setDetail] = useState<MailMessage | null>(null)
  const [mode, setMode] = useState<'formatted' | 'text'>('formatted')
  const [images, setImages] = useState(false)
  useEffect(() => {
    let active = true
    setDetail(null); setMode('formatted'); setImages(false)
    const client = getSharedApiClient()
    if (typeof client.mailMessage === 'function') {
      void client.mailMessage(message.id, { ...(offline ? { cacheOnly: true } : {}) }).then(value => { if (active && value?.id === message.id) setDetail(value) }).catch(() => {})
    }
    return () => { active = false }
  }, [message.id, message.version, offline])
  const html = detail?.id === message.id ? detail.body_html : message.body_html
  const document = useMemo(() => html ? mailDocument(html, images) : null, [html, images])
  if (!document) return <div className="mail-body">{message.body}</div>
  return <div className="mail-rich-body">
    <div className="mail-rich-tools" aria-label="Message display">
      <button type="button" aria-pressed={mode === 'formatted'} onClick={() => setMode('formatted')}>Formatted</button>
      <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Plain text</button>
      {mode === 'formatted' && document.remoteImages > 0 && !images && <button type="button" onClick={() => setImages(true)}>Load external images</button>}
      {images && <button type="button" onClick={() => setImages(false)}>Hide external images</button>}
    </div>
    {mode === 'formatted' && document.remoteImages > 0 && !images && <p className="mail-image-notice">Images are blocked. Loading them contacts the sender’s image servers.</p>}
    {mode === 'formatted'
      ? <iframe title="Formatted email" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={document.srcDoc} />
      : <div className="mail-body">{message.body}</div>}
  </div>
}
