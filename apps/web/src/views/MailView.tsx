import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { MailDesktop } from './mail/MailView.desktop'
import { MailMobile } from './mail/MailView.mobile'

export function MailView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <MailMobile apiStatus={apiStatus} /> : <MailDesktop apiStatus={apiStatus} />
}
