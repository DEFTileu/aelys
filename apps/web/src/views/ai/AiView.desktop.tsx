import { Calendar, ChevronRight, Folder, MessageSquareText, Sparkles, SquareCheck } from '../../icons'
import { navigate } from '../../lib/router'
import type { ApiStatus } from '../../types'
import { AiHistory, AiThread } from './AiShared'
import { useAi } from './useAi'

export function AiDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useAi(apiStatus)
  const { prompts, running, loading, setMessage } = t
  return <div className="actual-ai">
    <AiHistory {...t} />
    <AiThread {...t} />
    <aside className="actual-ai__side" aria-label="Chat resources">
      <section className="actual-ai__card actual-ai__side-card actual-ai__context"><h2><Sparkles size={17} />Context</h2><p className="actual-ai__side-copy">Open your workspace to review your information.</p><div className="actual-ai__actions">
        <button type="button" onClick={() => navigate('/tasks')}><span><SquareCheck size={17} /></span><b>Tasks</b><ChevronRight size={16} /></button>
        <button type="button" onClick={() => navigate('/calendar')}><span><Calendar size={17} /></span><b>Calendar</b><ChevronRight size={16} /></button>
        <button type="button" onClick={() => navigate('/projects')}><span><Folder size={17} /></span><b>Projects</b><ChevronRight size={16} /></button>
      </div></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__quick"><h2>Quick actions</h2><div className="actual-ai__prompts"><button type="button" onClick={() => navigate('/tasks')}><SquareCheck size={16} />Open tasks</button><button type="button" onClick={() => navigate('/notes')}><MessageSquareText size={16} />Open notes</button><button type="button" onClick={() => navigate('/calendar')}><Calendar size={16} />Open calendar</button></div></section>
      <section className="actual-ai__card actual-ai__side-card actual-ai__useful"><h2>Useful prompts</h2><p className="actual-ai__side-copy">Choose a prompt to edit before sending.</p><div className="actual-ai__prompts">{prompts.map(prompt => <button type="button" key={prompt.label} disabled={running || loading} onClick={() => setMessage(prompt.text)}><Sparkles size={16} />{prompt.label}</button>)}</div></section>
    </aside>
  </div>
}
