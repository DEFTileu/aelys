import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { AppsDesktop } from './apps/AppsView.desktop'
import { AppsMobile } from './apps/AppsView.mobile'

export { siteHost, siteUrl } from './apps/useApps'

export function AppsView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <AppsMobile apiStatus={apiStatus} /> : <AppsDesktop apiStatus={apiStatus} />
}
