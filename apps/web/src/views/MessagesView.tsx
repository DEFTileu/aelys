import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { MessagesDesktop } from './messages/MessagesView.desktop'
import { MessagesMobile } from './messages/MessagesView.mobile'

export function MessagesView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <MessagesMobile apiStatus={apiStatus} /> : <MessagesDesktop apiStatus={apiStatus} />
}
