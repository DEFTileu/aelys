import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { KnowledgeDesktop } from './knowledge/KnowledgeView.desktop'
import { KnowledgeMobile } from './knowledge/KnowledgeView.mobile'

export function KnowledgeView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <KnowledgeMobile apiStatus={apiStatus} /> : <KnowledgeDesktop apiStatus={apiStatus} />
}
