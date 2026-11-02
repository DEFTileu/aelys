import { useEffect, useRef } from 'react'
import { Plus } from '../../icons'
import type { ApiStatus } from '../../types'
import { AiHistory, AiThread } from './AiShared'
import { useAi } from './useAi'
import './ai-mobile.css'

// Chat and the conversation list are separate screens. The compose bar follows the on-screen keyboard.
export function AiMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useAi(apiStatus)
  const { historyOpen, setHistoryOpen, newChat, running, prompts, setMessage, loading, lines, partial } = t
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const follow = () => {
      const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      root.current?.style.setProperty('--ai-keyboard', `${offset}px`)
    }
    viewport.addEventListener('resize', follow)
    viewport.addEventListener('scroll', follow)
    follow()
    return () => { viewport.removeEventListener('resize', follow); viewport.removeEventListener('scroll', follow) }
  }, [])

  const empty = !loading && !lines.length && !partial
  return <div className="ai-m" ref={root}>
    <header className="ai-m-head">
      <h1>AI Chat</h1>
      <div>
        <button type="button" onClick={newChat} disabled={running}><Plus size={18} />New</button>
        <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? 'Back to chat' : 'Chats'}</button>
      </div>
    </header>
    {historyOpen ? <AiHistory {...t} /> : <AiThread {...t} />}
    {!historyOpen && empty && <div className="ai-m-prompts">{prompts.map(prompt => <button type="button" key={prompt.label} disabled={running || loading} onClick={() => setMessage(prompt.text)}>{prompt.label}</button>)}</div>}
  </div>
}
