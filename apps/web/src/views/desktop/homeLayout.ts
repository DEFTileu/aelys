// Widget catalog and persisted "My day" layout, ported from the Aelys Desktop script (DEF, WCAT, WDESC, saveLayout).
import { BookOpen, Calendar, CloudSun, Folder, Mail, NotebookText, SquareCheck, Timer, Wallet, Zap, type AelysIconComponent } from '../../icons'
import type { AccentKey } from '../../data/desktop/home'
import type { RoutePath } from '../../types'

export const HOME_LAYOUT_KEY = 'aelys.desktop.home.v1'

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

export const WIDGET_GRID_ROW = 124
export const WIDGET_GRID_GAP = 16
export const WIDGET_SIZES = [
  { id: 'small', label: 'Small', span: 1, rows: 2, height: 264 },
  { id: 'wide', label: 'Wide', span: 2, rows: 2, height: 264 },
  { id: 'large', label: 'Large', span: 2, rows: 4, height: 544 },
  { id: 'full', label: 'Full width', span: 4, rows: 2, height: 264 },
] as const

/** Legacy freeform dimensions are snapped to the nearest supported tile. */
export function normalizeWidgetSize(span: number, height = 264): { span: number; height: number; rows: number } {
  const width = [1, 2, 4].reduce((best, value) => Math.abs(value - span) < Math.abs(best - span) ? value : best, 1)
  const tall = Math.abs(height - 544) < Math.abs(height - 264)
  return { span: tall ? 2 : width, height: tall ? 544 : 264, rows: tall ? 4 : 2 }
}

export const DEFAULT_LAYOUT: LayoutEntry[] = [['today', 1, 264], ['cal', 1, 264], ['focus', 1, 264], ['weather', 1, 264], ['proj', 1, 264], ['notes', 1, 264], ['fin', 1, 264], ['kb', 1, 264], ['activity', 4, 264]]
export const MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v1'
export const MOBILE_DEFAULT_LAYOUT: LayoutEntry[] = [['today', 2, 264], ['focus', 1, 264], ['weather', 1, 264], ['cal', 2, 264], ['mail', 2, 264], ['notes', 1, 264], ['fin', 1, 264], ['proj', 2, 264]]

export function readLayout(mobile = false): LayoutEntry[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(mobile ? MOBILE_HOME_LAYOUT_KEY : HOME_LAYOUT_KEY) || 'null')
    if (Array.isArray(stored)) {
      const seen = new Set<string>()
      return stored.flatMap((entry): LayoutEntry[] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Object.hasOwn(WIDGET_CATALOG, entry[0]) || seen.has(entry[0]) || !Number.isFinite(entry[1])) return []
        seen.add(entry[0])
        const size = normalizeWidgetSize(entry[1], Number.isFinite(entry[2]) ? entry[2] : 264)
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
