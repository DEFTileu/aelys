// Widget catalog and persisted "My day" layout, ported from the Aelys Desktop script (DEF, WCAT, WDESC, saveLayout).
import { BookOpen, Calendar, CloudSun, Folder, Mail, NotebookText, SquareCheck, Timer, Wallet, Zap, type LucideIcon } from 'lucide-react'
import type { AccentKey } from '../../data/desktop/home'
import type { RoutePath } from '../../types'

export const HOME_LAYOUT_KEY = 'aelys.desktop.home.v1'

export type WidgetId = 'today' | 'cal' | 'focus' | 'weather' | 'proj' | 'notes' | 'fin' | 'kb' | 'mail' | 'activity'
export type LayoutEntry = [WidgetId, number]

export type WidgetDefinition = {
  title: string
  icon: LucideIcon
  color: AccentKey
  description: string
  meta?: string
  link?: { label: string; route?: RoutePath }
}

export const WIDGET_CATALOG: Record<WidgetId, WidgetDefinition> = {
  today: { title: 'Today', icon: SquareCheck, color: 'blue', description: 'Tasks with checkboxes' },
  cal: { title: 'Calendar', icon: Calendar, color: 'red', description: 'Upcoming events', meta: 'Wed, Oct 28', link: { label: 'Open', route: '/calendar' } },
  focus: { title: 'Focus', icon: Timer, color: 'coral', description: 'Active focus timer', meta: 'Session 2 of 4' },
  weather: { title: 'Weather', icon: CloudSun, color: 'blue', description: 'Temperature and forecast', meta: 'Almaty' },
  proj: { title: 'Projects', icon: Folder, color: 'violet', description: 'Progress across projects', link: { label: 'All', route: '/projects' } },
  notes: { title: 'Notes', icon: NotebookText, color: 'orange', description: 'Most recent notes', link: { label: 'All', route: '/notes' } },
  fin: { title: 'Finances', icon: Wallet, color: 'green', description: 'Balance and spending', meta: 'October' },
  kb: { title: 'Knowledge base', icon: BookOpen, color: 'violet', description: 'Recently opened docs' },
  mail: { title: 'Mail', icon: Mail, color: 'blue', description: 'Latest unread emails', link: { label: 'Open', route: '/mail' } },
  activity: { title: 'Recent activity', icon: Zap, color: 'violet', description: 'What happened recently', link: { label: 'All events', route: '/calendar' } },
}

export const WIDGET_IDS = Object.keys(WIDGET_CATALOG) as WidgetId[]

export const DEFAULT_LAYOUT: LayoutEntry[] = [['today', 1], ['cal', 1], ['focus', 1], ['weather', 1], ['proj', 1], ['notes', 1], ['fin', 1], ['kb', 1], ['activity', 4]]

export function readLayout(): LayoutEntry[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(HOME_LAYOUT_KEY) || 'null')
    if (Array.isArray(stored)) {
      return stored.filter((entry): entry is LayoutEntry => Array.isArray(entry) && typeof entry[1] === 'number' && typeof entry[0] === 'string' && Object.hasOwn(WIDGET_CATALOG, entry[0]))
    }
  } catch {
    // Unreadable or missing storage falls back to the default layout.
  }
  return DEFAULT_LAYOUT.map((entry) => [...entry] as LayoutEntry)
}

export function saveLayout(layout: LayoutEntry[]) {
  try {
    window.localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // Storage can be blocked; the layout still applies for this session.
  }
}
