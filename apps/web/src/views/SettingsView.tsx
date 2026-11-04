import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { SettingsDesktop } from './settings/SettingsView.desktop'
import { SettingsMobile } from './settings/SettingsView.mobile'

export function SettingsView({ apiStatus }: { apiStatus: ApiStatus; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  return useIsMobile() ? <SettingsMobile apiStatus={apiStatus} /> : <SettingsDesktop apiStatus={apiStatus} />
}
