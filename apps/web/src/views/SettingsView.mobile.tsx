import type { ApiStatus } from '../types'
import { SettingsBody, SettingsNavList, SettingsSearch } from './settings/SettingsShared'
import { useSettings } from './settings/useSettings'
import './actual-settings.css'
import './settings/settings.css'
import './settings/settings-mobile.css'

// One screen at a time: the grouped list, or the open panel with a Back button.
export function SettingsMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useSettings(apiStatus)
  return <div className="st st-m">
    {t.open
      ? <main className="st-panel"><SettingsBody t={t} /></main>
      : <div className="st-m-list"><SettingsSearch t={t} /><SettingsNavList t={t} /></div>}
  </div>
}
