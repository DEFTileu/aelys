import type { ApiStatus } from '../types'
import { ModuleDesktop } from './module/ModuleView.desktop'
import { ModuleMobile } from './module/ModuleView.mobile'
import { useIsMobile } from '../lib/useIsMobile'
import type { ModuleConfig } from './module/moduleConfigs'

export type { ModuleConfig } from './module/moduleConfigs'
export { moduleConfigs } from './module/moduleConfigs'

export function ModuleView({ config, apiStatus }: { config: ModuleConfig; apiStatus: ApiStatus }) {
  return useIsMobile() ? <ModuleMobile config={config} apiStatus={apiStatus} /> : <ModuleDesktop config={config} apiStatus={apiStatus} />
}
