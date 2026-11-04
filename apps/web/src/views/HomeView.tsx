import { useWindowWidth } from '../lib/desktopStore'
import type { ApiStatus } from '../types'
import { HomeDesktop } from './home/HomeView.desktop'
import { HomeMobile } from './home/HomeView.mobile'

// Width breakpoint (not useIsMobile) keeps the original <=700px switch.
export function HomeView({ apiStatus }: { apiStatus?: ApiStatus }) {
  return useWindowWidth() <= 700 ? <HomeMobile apiStatus={apiStatus} /> : <HomeDesktop apiStatus={apiStatus} />
}
