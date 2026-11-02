import { ApiStatusPill } from '../../components/ApiStatusPill'
import { PageSkeleton } from '../../components/PageSkeleton'
import type { ApiStatus } from '../../types'
import '../actual-knowledge.css'
import './knowledge-mobile.css'
import { KnowledgeList, KnowledgeReader } from './KnowledgeShared'
import { useKnowledge } from './useKnowledge'

// The document list and the reader are separate screens; the reader's Back button returns to the list.
export function KnowledgeMobile({ apiStatus: initialStatus }: { apiStatus: ApiStatus }) {
  const t = useKnowledge(initialStatus)
  const { status, notes, load, reading, selected } = t
  return <div className="knowledge-m">
    <div className="knowledge-m-head"><ApiStatusPill status={status} /></div>
    {status !== 'ready' && notes.length > 0 && <div className="knowledge-warning" role="status">{status === 'loading' ? 'Refreshing notes…' : 'Could not refresh notes.'} {status !== 'loading' && <button type="button" className="knowledge-button" onClick={() => void load()}>Try again</button>}</div>}
    {status !== 'ready' && notes.length === 0
      ? <PageSkeleton kind="split" label="knowledge base" phase={status === 'loading' ? 'loading' : 'error'} onRetry={() => void load()} />
      : reading && selected ? <KnowledgeReader t={t} /> : <KnowledgeList t={t} />}
  </div>
}
