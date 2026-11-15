import { useEffect, useState } from 'react'
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

const CONFIGURED = 'aelys.appLimits.configured'
/** Set once the owner has limits; never cleared, so a later broken setup is not silently ignored. */
export function markLimitsConfigured(): void { try { localStorage.setItem(CONFIGURED, '1') } catch { /* storage blocked: the app-wide banner stays off */ } }
function limitsConfigured(): boolean { try { return localStorage.getItem(CONFIGURED) === '1' } catch { return false } }

/** 'off': a permission is missing; 'unknown': the status could not be read. */
export type ProtectionProblem = 'off' | 'unknown' | null

/**
 * Android only, and only once limits were configured here: reads the guard status on open and on each return
 * to the foreground. `dismiss` hides the problem until the next check, never longer.
 */
export function useProtectionProblem(): { problem: ProtectionProblem; dismiss: () => void } {
  const [problem, setProblem] = useState<ProtectionProblem>(null)
  useEffect(() => {
    if (!isAndroidHost()) return
    let alive = true
    const check = async () => {
      if (!limitsConfigured()) return
      const next: ProtectionProblem = await focusGuard.status().then((s) => s.usageAccess && s.accessibility ? null : 'off', () => 'unknown')
      if (alive) setProblem(next)
    }
    const again = () => { if (document.visibilityState !== 'hidden') void check() }
    void check()
    document.addEventListener('visibilitychange', again); window.addEventListener('focus', again)
    return () => { alive = false; document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again) }
  }, [])
  return { problem, dismiss: () => setProblem(null) }
}
