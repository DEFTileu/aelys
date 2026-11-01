import { useSyncExternalStore } from 'react'

// Client-side display preferences from Settings. Each one has a visible effect: the owner name feeds the sidebar
// profile and the Home greeting, `glass` and `reduceMotion` restyle the shell, and `units` changes the weather readouts.
export type Prefs = { name: string; greeting: 'time' | 'hello'; glass: boolean; reduceMotion: boolean; units: 'c' | 'f' }

const KEY = 'aelys.prefs.v1'
const DEFAULTS: Prefs = { name: '', greeting: 'time', glass: true, reduceMotion: false, units: 'c' }

function load(): Prefs {
  const next = { ...DEFAULTS }
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || 'null') as Partial<Record<keyof Prefs, unknown>> | null
    if (typeof stored?.name === 'string') next.name = stored.name.slice(0, 60)
    if (stored?.greeting === 'hello') next.greeting = 'hello'
    if (typeof stored?.glass === 'boolean') next.glass = stored.glass
    if (typeof stored?.reduceMotion === 'boolean') next.reduceMotion = stored.reduceMotion
    if (stored?.units === 'f') next.units = 'f'
  } catch {
    // Unreadable or blocked storage falls back to the defaults.
  }
  return next
}

let prefs = load()
const listeners = new Set<() => void>()

function applyToDocument() {
  if (typeof document !== 'undefined') document.documentElement.dataset.reduceMotion = prefs.reduceMotion ? 'true' : 'false'
}
applyToDocument()

export function getPrefs(): Prefs {
  return prefs
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch }
  try { window.localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* Storage can be blocked; the choice still applies for this session. */ }
  applyToDocument()
  listeners.forEach((listener) => listener())
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getPrefs)
}

// Weather is fetched in Celsius and km/h; the readouts convert on display.
export const formatTemperature = (celsius: number, units: Prefs['units']) => `${Math.round(units === 'f' ? celsius * 9 / 5 + 32 : celsius)}°${units === 'f' ? 'F' : 'C'}`
export const formatWind = (kmh: number, units: Prefs['units']) => units === 'f' ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh / 3.6)} m/s`
