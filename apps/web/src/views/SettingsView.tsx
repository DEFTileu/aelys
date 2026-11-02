import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { SettingsDesktop } from './SettingsView.desktop'
import { SettingsMobile } from './SettingsView.mobile'

export function SettingsView({ apiStatus }: { apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  return useIsMobile() ? <SettingsMobile apiStatus={apiStatus} /> : <SettingsDesktop apiStatus={apiStatus} />
}
