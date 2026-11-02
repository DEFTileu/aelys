import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { HomeDesktop } from './home/HomeView.desktop'
import { HomeMobile } from './home/HomeView.mobile'

export function HomeView({ apiStatus }: { apiStatus?: ApiStatus }) {
  return useIsMobile() ? <HomeMobile apiStatus={apiStatus} /> : <HomeDesktop apiStatus={apiStatus} />
}
