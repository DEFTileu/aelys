import { useEffect } from 'react'
import { focusGuard } from './focusGuard'
import { isAndroidHost } from './notificationLog'
import { navigate } from './router'

// The native block screen only relaunches Aelys, so the app id is read here, app-wide, and parked until the app limits screen takes it.
let waiting: string | null = null
const listeners = new Set<() => void>()

export function setUnlockHandoff(appId: string): void { waiting = appId; listeners.forEach((listener) => listener()) }
export function takeUnlockHandoff(): string | null { const id = waiting; waiting = null; return id }
/** Tells a mounted app limits screen that an id is waiting; returns the unsubscribe. */
export function subscribeUnlockHandoff(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

/** On open and on return to the foreground (Android only): read the plugin's pending unlock and open the app limits screen. */
export function useUnlockHandoff(): void {
  useEffect(() => {
    if (!isAndroidHost()) return
    let alive = true
    const check = async () => {
      const id = await focusGuard.takePendingUnlock().catch(() => null)
      if (!id) return
      setUnlockHandoff(id) // kept even if this effect is gone, so the id is never lost
      if (alive) navigate('/app-limits')
    }
    const again = () => { if (document.visibilityState !== 'hidden') void check() }
    void check()
    document.addEventListener('visibilitychange', again); window.addEventListener('focus', again)
    return () => { alive = false; document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again) }
  }, [])
}
