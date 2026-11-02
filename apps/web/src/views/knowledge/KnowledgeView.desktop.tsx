import { PageSkeleton } from '../../components/PageSkeleton'
import { ApiStatusPill } from '../../components/ApiStatusPill'
import type { ApiStatus } from '../../types'
import '../desktop/page-tokens.css'
import '../actual-knowledge.css'
import '../desktop/knowledge.css'
import { KnowledgeList, KnowledgeReader } from './KnowledgeShared'
import { useKnowledge } from './useKnowledge'

export function KnowledgeDesktop({ apiStatus: initialStatus }: { apiStatus: ApiStatus }) {
  const t = useKnowledge(initialStatus)
  const { apiStatus, status, notes, query, setQuery, selectedId, setSelectedId, reading, setReading, load, visible, groups, selected, selectedGroup, edit } = t
  return <div className={`knowledge-view page${reading ? ' knowledge-view--reading' : ''}`}>
    <div className="knowledge-status"><ApiStatusPill status={status} /></div>
    {status !== 'ready' && notes.length === 0 ? <PageSkeleton kind="split" label="knowledge base" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} /> : <>
      {status !== 'ready' && <div className="knowledge-warning" role="status">{status === 'loading' ? 'Refreshing notes…' : 'Could not refresh notes.'} {status !== 'loading' && <button type="button" className="knowledge-button" onClick={() => void load()}>Try again</button>}</div>}
      <div className="knowledge-grid">
        <KnowledgeList t={t} />
        <KnowledgeReader t={t} />
      </div>
    </>}
  </div>
}
