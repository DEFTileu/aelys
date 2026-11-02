import type { ApiStatus } from '../types'
import { SettingsBody, SettingsNavList, SettingsSearch } from './settings/SettingsShared'
import { useSettings } from './settings/useSettings'
import './actual-settings.css'
import './settings/settings.css'

export function SettingsDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const t = useSettings(apiStatus)
  return <div className="st" data-open={t.open}>
    <aside className="st-nav" aria-label="Settings">
      <SettingsSearch t={t} />
      <SettingsNavList t={t} />
    </aside>
    <main className="st-panel">
      <SettingsBody t={t} />
    </main>
  </div>
}
