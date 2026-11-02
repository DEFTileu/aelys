import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { ProjectsDesktop } from './projects/ProjectsView.desktop'
import { ProjectsMobile } from './projects/ProjectsView.mobile'

export function ProjectsView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <ProjectsMobile apiStatus={apiStatus} /> : <ProjectsDesktop apiStatus={apiStatus} />
}
