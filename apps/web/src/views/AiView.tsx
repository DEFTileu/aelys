import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import './actual-ai.css'
import './desktop/page-tokens.css'
import './desktop/ai.css'
import { AiDesktop } from './ai/AiView.desktop'
import { AiMobile } from './ai/AiView.mobile'

export function AiView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <AiMobile apiStatus={apiStatus} /> : <AiDesktop apiStatus={apiStatus} />
}
