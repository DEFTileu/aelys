import type { FocusApp, FocusOverview } from '@aelys/shared'

export type GuardStatus = { usageAccess: boolean; accessibility: boolean }
export type SettingsTarget = 'usage' | 'accessibility' | 'app'
/** What the device keeps of the config: flat app lists. `pending: null` (none) differs from `[]` (remove all). */
export type GuardState = { effective: FocusApp[]; pending: FocusApp[] | null; effectiveFrom: string | null; dayUnlockedOn: string | null }
export type AppUsage = { usedSeconds: number; limitSeconds: number; grantedSeconds: number }
export type InstalledApp = { pkg: string; label: string }

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(`plugin:aelys-focus-guard|${command}`, args)
}

/** The owner's calendar day on this device (not UTC), as `YYYY-MM-DD`. */
export const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export const focusGuard = {
  status: () => call<GuardStatus>('status'),
  openSettings: (target: SettingsTarget) => call<void>('open_settings', { target }),
  setState: (state: GuardState) => call<void>('set_state', { state }),
  usage: async () => (await call<{ usage: Record<string, AppUsage> }>('usage')).usage,
  applyGrant: (appId: string, seconds: number, day: string) => call<void>('apply_grant', { appId, seconds, day }),
  installedApps: async () => (await call<{ apps: InstalledApp[] }>('installed_apps')).apps,
  takePendingUnlock: async () => (await call<{ appId: string | null }>('take_pending_unlock')).appId,
}

/**
 * Pushes a loaded backend overview to the device guard. Refuses anything else: an empty state would
 * switch all guarding off, so a failed load must never reach `set_state`.
 */
export async function syncGuard(overview: FocusOverview): Promise<void> {
  const config = overview?.config
  if (!config?.effective || !Array.isArray(config.effective.apps)) throw new Error('syncGuard needs a loaded focus overview')
  await focusGuard.setState({
    effective: [...config.effective.apps],
    pending: config.pending ? [...config.pending.apps] : null,
    effectiveFrom: config.effective_from,
    dayUnlockedOn: overview.day_unlocked ? localDay() : null,
  })
}
