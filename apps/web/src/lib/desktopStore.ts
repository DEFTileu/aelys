// Shared desktop state: Today task checkboxes, appearance settings and the pending Ask Aelys question.
// Task and settings fields persist to localStorage; the pending question and Customize flag are per session.
import { useSyncExternalStore } from 'react'
import { navigate } from './router'

const STORAGE_KEY = 'aelys.desktop.state.v1'

export type DesktopSettings = { wallpaper: number; transparency: number; blur: number; accent: number }

export type DesktopState = DesktopSettings & {
  // Five Today tasks, by position; Home and Tasks read the same slots.
  done: boolean[]
  pendingAsk: string | null
  customizeHome: boolean
}

const DEFAULTS: DesktopState = {
  done: [true, true, false, false, false],
  wallpaper: 0,
  transparency: 70,
  blur: 40,
  accent: 0,
  pendingAsk: null,
  customizeHome: false,
}

function load(): DesktopState {
  const base = { ...DEFAULTS, done: [...DEFAULTS.done] }
  try {
    const stored: Partial<Record<keyof DesktopSettings | 'done', unknown>> = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') ?? {}
    if (Array.isArray(stored.done) && stored.done.length === base.done.length) base.done = stored.done.map(Boolean)
    for (const key of ['wallpaper', 'transparency', 'blur', 'accent'] as const) {
      const value = stored[key]
      if (typeof value === 'number') base[key] = value
    }
  } catch {
    // Unreadable or blocked storage falls back to the defaults.
  }
  return base
}

let state = load()
const listeners = new Set<() => void>()

function update(patch: Partial<DesktopState>) {
  state = { ...state, ...patch }
  try {
    const { done, wallpaper, transparency, blur, accent } = state
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ done, wallpaper, transparency, blur, accent }))
  } catch {
    // Storage can be blocked; the state still applies for this session.
  }
  listeners.forEach((listener) => listener())
}

export function subscribeDesktop(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getDesktopState(): DesktopState {
  return state
}

export function useDesktopState(): DesktopState {
  return useSyncExternalStore(subscribeDesktop, getDesktopState)
}

export function toggleTask(index: number) {
  update({ done: state.done.map((on, i) => (i === index ? !on : on)) })
}

export function setSettings(patch: Partial<DesktopSettings>) {
  update(patch)
}

// Hands the question to ChatScreen, which takes it once; any Ask Aelys surface can call this.
export function askAelys(text: string) {
  update({ pendingAsk: text })
  navigate('/ai')
}

export function takePendingAsk(): string | null {
  const text = state.pendingAsk
  if (text) update({ pendingAsk: null })
  return text
}

export function requestCustomizeHome() {
  update({ customizeHome: true })
}

export function takeCustomizeHome(): boolean {
  const on = state.customizeHome
  if (on) update({ customizeHome: false })
  return on
}

function subscribeResize(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth)
}
