import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { AiDesktop } from './ai/AiView.desktop'
import { AiMobile } from './ai/AiView.mobile'

export function AiView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <AiMobile apiStatus={apiStatus} /> : <AiDesktop apiStatus={apiStatus} />
}
