// Widget catalog and persisted "My day" layout, ported from the Aelys Desktop script (DEF, WCAT, WDESC, saveLayout).
import { BookOpen, Calendar, CloudSun, Folder, Mail, NotebookText, SquareCheck, Timer, Wallet, Zap, type AelysIconComponent } from '../../icons'
import type { AccentKey } from '../../data/desktop/home'
import type { RoutePath } from '../../types'

export const HOME_LAYOUT_KEY = 'aelys.desktop.home.v2'
export const LEGACY_HOME_LAYOUT_KEY = 'aelys.desktop.home.v1'
export const LEGACY_MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v1'

export type WidgetId = 'today' | 'cal' | 'focus' | 'weather' | 'proj' | 'notes' | 'fin' | 'kb' | 'mail' | 'activity'
export type LayoutEntry = [WidgetId, number, number?]

export type WidgetDefinition = {
  title: string
  icon: AelysIconComponent
  color: AccentKey
  description: string
  meta?: string
  link?: { label: string; route?: RoutePath }
}

export const WIDGET_CATALOG: Record<WidgetId, WidgetDefinition> = {
  today: { title: 'Today', icon: SquareCheck, color: 'blue', description: 'Tasks with checkboxes' },
  cal: { title: 'Calendar', icon: Calendar, color: 'red', description: 'Upcoming events', link: { label: 'Open', route: '/calendar' } },
  focus: { title: 'Focus', icon: Timer, color: 'coral', description: 'Active focus timer' },
  weather: { title: 'Weather', icon: CloudSun, color: 'blue', description: 'Temperature and forecast' },
  proj: { title: 'Projects', icon: Folder, color: 'violet', description: 'Progress across projects', link: { label: 'All', route: '/projects' } },
  notes: { title: 'Notes', icon: NotebookText, color: 'orange', description: 'Most recent notes', link: { label: 'All', route: '/notes' } },
  fin: { title: 'Finances', icon: Wallet, color: 'green', description: 'Balance and spending' },
  kb: { title: 'Knowledge base', icon: BookOpen, color: 'violet', description: 'Recent knowledge notes', link: { label: 'Open', route: '/knowledge' } },
  mail: { title: 'Mail', icon: Mail, color: 'blue', description: 'Latest imported emails', link: { label: 'Open', route: '/mail' } },
  activity: { title: 'Recent activity', icon: Zap, color: 'violet', description: 'What happened recently' },
}

export const WIDGET_IDS = Object.keys(WIDGET_CATALOG) as WidgetId[]

export const WIDGET_GRID_ROW = 176
export const WIDGET_GRID_GAP = 16
export const WIDGET_SIZES = [
  { id: '1x1', label: '1 × 1', span: 1, rows: 1, height: 176 },
  { id: '1x2', label: '1 × 2', span: 1, rows: 2, height: 368 },
  { id: '1x3', label: '1 × 3', span: 1, rows: 3, height: 560 },
  { id: '2x1', label: '2 × 1', span: 2, rows: 1, height: 176 },
  { id: '2x2', label: '2 × 2', span: 2, rows: 2, height: 368 },
  { id: '2x3', label: '2 × 3', span: 2, rows: 3, height: 560 },
  { id: '4x1', label: '4 × 1', span: 4, rows: 1, height: 176 },
] as const

/** Legacy freeform dimensions are snapped to the nearest supported tile. */
export function normalizeWidgetSize(span: number, height = WIDGET_GRID_ROW): { span: number; height: number; rows: number } {
  const width = [1, 2, 4].reduce((best, value) => Math.abs(value - span) < Math.abs(best - span) ? value : best, 1)
  const available = WIDGET_SIZES.filter(size => size.span === width)
  const size = available.reduce((best, value) => Math.abs(value.height - height) < Math.abs(best.height - height) ? value : best)
  return { span: size.span, height: size.height, rows: size.rows }
}

export const DEFAULT_LAYOUT: LayoutEntry[] = [['today', 1, 176], ['cal', 1, 176], ['focus', 1, 176], ['weather', 1, 176], ['proj', 1, 176], ['notes', 1, 176], ['fin', 1, 176], ['kb', 1, 176], ['activity', 4, 176]]
export const MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v2'
export const MOBILE_DEFAULT_LAYOUT: LayoutEntry[] = [['today', 2, 176], ['focus', 1, 176], ['weather', 1, 176], ['cal', 2, 176], ['mail', 2, 176], ['notes', 1, 176], ['fin', 1, 176], ['proj', 2, 176]]

export function readLayout(mobile = false): LayoutEntry[] {
  try {
    const current = window.localStorage.getItem(mobile ? MOBILE_HOME_LAYOUT_KEY : HOME_LAYOUT_KEY)
    const legacy = current === null
    const stored: unknown = JSON.parse(current ?? window.localStorage.getItem(mobile ? LEGACY_MOBILE_HOME_LAYOUT_KEY : LEGACY_HOME_LAYOUT_KEY) ?? 'null')
    if (Array.isArray(stored)) {
      const seen = new Set<string>()
      return stored.flatMap((entry): LayoutEntry[] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Object.hasOwn(WIDGET_CATALOG, entry[0]) || seen.has(entry[0]) || !Number.isFinite(entry[1])) return []
        seen.add(entry[0])
        const height = Number.isFinite(entry[2]) ? entry[2] : legacy ? 264 : WIDGET_GRID_ROW
        // v1's tall preset always occupied two columns; preserve that intent.
        const tall = legacy && Math.abs(height - 544) < Math.abs(height - 264)
        const size = normalizeWidgetSize(tall ? 2 : entry[1], legacy ? tall ? 368 : 176 : height)
        return [[entry[0] as WidgetId, size.span, size.height]]
      })
    }
  } catch {
    // Unreadable or missing storage falls back to the default layout.
  }
  return (mobile ? MOBILE_DEFAULT_LAYOUT : DEFAULT_LAYOUT).map((entry) => [...entry] as LayoutEntry)
}

export function saveLayout(layout: LayoutEntry[], mobile = false) {
  try {
    window.localStorage.setItem(mobile ? MOBILE_HOME_LAYOUT_KEY : HOME_LAYOUT_KEY, JSON.stringify(layout.map(([id, span, height]) => { const size = normalizeWidgetSize(span, height); return [id, size.span, size.height] })))
    return true
  } catch {
    // Let the UI distinguish a durable change from a session-only preview.
    return false
  }
}

/** Insert at the target position, preserving every widget and its dimensions. */
export function reorderLayout(layout: LayoutEntry[], source: WidgetId, target: WidgetId): LayoutEntry[] {
  const from = layout.findIndex(([id]) => id === source)
  const to = layout.findIndex(([id]) => id === target)
  if (from < 0 || to < 0 || from === to) return layout
  const result = [...layout]
  const [entry] = result.splice(from, 1)
  result.splice(to, 0, entry)
  return result
}
