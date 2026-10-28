import { FormEvent, useState } from 'react'
import { Icon } from './Icon'
import { navigate } from '../lib/router'

export function AiCommandBar({ compact = false }: { compact?: boolean }) {
  const [query, setQuery] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) return
    navigate('/ai')
  }

  return <form className={`ai-command ${compact ? 'ai-command--compact' : ''}`} onSubmit={submit} aria-label="Ask Aelys">
    <span className="ai-command__orb" aria-hidden="true"><Icon name="sparkles" size={18} /></span>
    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask Aelys or find something…" aria-label="Ask Aelys or search" />
    <button type="submit" className="icon-button icon-button--accent" aria-label="Open AI Chat" title="Open AI Chat"><Icon name="arrow-up" size={17} /></button>
  </form>
}
