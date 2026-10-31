// Widget catalog and persisted "My day" layout, ported from the Aelys Desktop script (DEF, WCAT, WDESC, saveLayout).
import { BookOpen, Calendar, CloudSun, Folder, Mail, NotebookText, SquareCheck, Timer, Wallet, Zap, type AelysIconComponent } from '../../icons'
import type { AccentKey } from '../../data/desktop/home'
import type { RoutePath } from '../../types'

export const HOME_LAYOUT_KEY = 'aelys.desktop.home.v4'
export const MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v4'
export const PREVIOUS_HOME_LAYOUT_KEY = 'aelys.desktop.home.v3'
export const PREVIOUS_MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v3'
export const OLDER_HOME_LAYOUT_KEY = 'aelys.desktop.home.v2'
export const OLDER_MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v2'
export const LEGACY_HOME_LAYOUT_KEY = 'aelys.desktop.home.v1'
export const LEGACY_MOBILE_HOME_LAYOUT_KEY = 'aelys.mobile.home.v1'

export type WidgetId = 'today' | 'cal' | 'focus' | 'weather' | 'proj' | 'notes' | 'fin' | 'kb' | 'mail' | 'activity'
/** [widget, column span, pixel height, instance key]. The key is only stored for a second copy of a widget. */
export type LayoutEntry = [WidgetId, number, number?, string?]
export type SizeKey = 'S' | 'M' | 'L' | 'Tall'

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

export const WIDGET_GRID_ROW = 264
export const WIDGET_GRID_GAP = 16
export const WIDGET_SIZES = [
  { id: '1x1', key: 'S', label: 'S', span: 1, rows: 1, height: 264 },
  { id: '2x1', key: 'M', label: 'M', span: 2, rows: 1, height: 264 },
  { id: '2x2', key: 'L', label: 'L', span: 2, rows: 2, height: 544 },
  { id: '1x2', key: 'Tall', label: 'Tall', span: 1, rows: 2, height: 544 },
] as const

export type WidgetSize = { id: string; key: SizeKey; span: number; height: number; rows: number }

/** Legacy freeform dimensions snap to the nearest of S / M / L / Tall. */
export function normalizeWidgetSize(span: number, height = WIDGET_GRID_ROW): WidgetSize {
  const wide = span >= 1.5
  const tall = height >= 320
  const size = WIDGET_SIZES.find(item => (item.span === 2) === wide && (item.rows === 2) === tall)!
  return { id: size.id, key: size.key, span: size.span, height: size.height, rows: size.rows }
}
export const sizeByKey = (key: SizeKey) => WIDGET_SIZES.find(size => size.key === key)!

export const DEFAULT_SIZES: Record<WidgetId, SizeKey> = { today: 'M', cal: 'M', focus: 'S', weather: 'S', proj: 'M', notes: 'S', fin: 'M', kb: 'M', mail: 'S', activity: 'M' }
const sized = (id: WidgetId): LayoutEntry => { const size = sizeByKey(DEFAULT_SIZES[id]); return [id, size.span, size.height] }
export const layoutKey = (entry: LayoutEntry) => entry[3] ?? entry[0]
/** A second copy of a widget gets its own stable key so cards can be told apart. */
export const newLayoutEntry = (id: WidgetId, size: SizeKey, layout: readonly LayoutEntry[]): LayoutEntry => {
  const { span, height } = sizeByKey(size)
  return layout.some(entry => entry[0] === id) ? [id, span, height, `${id}-${Date.now().toString(36)}${layout.length}`] : [id, span, height]
}

export const DEFAULT_LAYOUT: LayoutEntry[] = (['today', 'focus', 'weather', 'cal', 'proj', 'fin', 'notes', 'mail'] as WidgetId[]).map(sized)
export const MOBILE_DEFAULT_LAYOUT: LayoutEntry[] = (['today', 'focus', 'weather', 'cal', 'mail', 'notes', 'fin', 'proj'] as WidgetId[]).map(sized)

export function readLayout(mobile = false): LayoutEntry[] {
  try {
    const keys = mobile
      ? [MOBILE_HOME_LAYOUT_KEY, PREVIOUS_MOBILE_HOME_LAYOUT_KEY, OLDER_MOBILE_HOME_LAYOUT_KEY, LEGACY_MOBILE_HOME_LAYOUT_KEY]
      : [HOME_LAYOUT_KEY, PREVIOUS_HOME_LAYOUT_KEY, OLDER_HOME_LAYOUT_KEY, LEGACY_HOME_LAYOUT_KEY]
    const stored: unknown = JSON.parse(keys.map(key => window.localStorage.getItem(key)).find(value => value !== null) ?? 'null')
    if (Array.isArray(stored)) {
      const seen = new Set<string>()
      return stored.flatMap((entry): LayoutEntry[] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Object.hasOwn(WIDGET_CATALOG, entry[0]) || !Number.isFinite(entry[1])) return []
        const id = entry[0] as WidgetId
        const key = typeof entry[3] === 'string' && entry[3] ? entry[3] : id
        if (seen.has(key)) return []
        seen.add(key)
        // Span 0 was the removed Auto mode: it becomes the widget's default size.
        const size = entry[1] === 0 ? sizeByKey(DEFAULT_SIZES[id]) : normalizeWidgetSize(entry[1], Number.isFinite(entry[2]) ? entry[2] : WIDGET_GRID_ROW)
        return [key === id ? [id, size.span, size.height] : [id, size.span, size.height, key]]
      })
    }
  } catch {
    // Unreadable or missing storage falls back to the default layout.
  }
  return (mobile ? MOBILE_DEFAULT_LAYOUT : DEFAULT_LAYOUT).map((entry) => [...entry] as LayoutEntry)
}

export function saveLayout(layout: LayoutEntry[], mobile = false) {
  try {
    window.localStorage.setItem(mobile ? MOBILE_HOME_LAYOUT_KEY : HOME_LAYOUT_KEY, JSON.stringify(layout.map(entry => { const size = normalizeWidgetSize(entry[1], entry[2]); return entry[3] ? [entry[0], size.span, size.height, entry[3]] : [entry[0], size.span, size.height] })))
    return true
  } catch {
    // Let the UI distinguish a durable change from a session-only preview.
    return false
  }
}

/** Insert at the target position, preserving every widget and its dimensions. */
export function reorderLayout(layout: LayoutEntry[], source: string, target: string): LayoutEntry[] {
  const from = layout.findIndex(entry => layoutKey(entry) === source)
  const to = layout.findIndex(entry => layoutKey(entry) === target)
  if (from < 0 || to < 0 || from === to) return layout
  const result = [...layout]
  const [entry] = result.splice(from, 1)
  result.splice(to, 0, entry)
  return result
}
