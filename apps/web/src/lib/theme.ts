import { useEffect, useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
const KEY = 'aelys.theme'
const EVENT = 'aelys:theme'
let sessionPreference: ThemePreference | null = null
const media = () => window.matchMedia?.('(prefers-color-scheme: dark)')
export function getThemePreference(): ThemePreference {
  if (sessionPreference) return sessionPreference
  try { const value = localStorage.getItem(KEY); return value === 'system' || value === 'dark' ? value : 'light' }
  catch { return sessionPreference ?? 'light' }
}
export function setThemePreference(value: ThemePreference) {
  try { localStorage.setItem(KEY, value); sessionPreference = null } catch { sessionPreference = value }
  window.dispatchEvent(new Event(EVENT))
}
function subscribe(listener: () => void) {
  const query = media()
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener() }
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', storage)
  query?.addEventListener('change', listener)
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', storage); query?.removeEventListener('change', listener) }
}
export function useThemePreference() { return useSyncExternalStore(subscribe, getThemePreference) }
export function useTheme(): ['light' | 'dark', () => void] {
  const theme = useSyncExternalStore(subscribe, () => getThemePreference() === 'system' ? media()?.matches ? 'dark' : 'light' : getThemePreference() as 'light' | 'dark')
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  return [theme, () => setThemePreference(theme === 'dark' ? 'light' : 'dark')]
}
