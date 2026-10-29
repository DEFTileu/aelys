// Demo content and widget catalog for the phone layout, ported from the Claude Design "Aelys Mobile" script.
import { Calendar, ChartColumn, CircleDot, CloudDrizzle, CloudRain, CloudSun, FileText, Folder, GraduationCap, Lightbulb, Mail, NotebookText, Presentation, Sparkles, SquareCheck, Sun, Target, Timer, Wallet, Wrench, type LucideIcon } from 'lucide-react'
import type { AccentKey } from './desktop/home'

export type MobileWidgetId = 'today' | 'cal' | 'focus' | 'weather' | 'mail' | 'proj' | 'notes' | 'fin' | 'goals'
// S is half width, M and L are full width; L shows more rows.
export type WidgetSize = 'S' | 'M' | 'L'
export type MobileWidget = [MobileWidgetId, WidgetSize]

export const MOBILE_CATALOG: Record<MobileWidgetId, { title: string; icon: LucideIcon; color: AccentKey; sizes: WidgetSize[]; description: string }> = {
  today: { title: 'Today', icon: SquareCheck, color: 'blue', sizes: ['M', 'L'], description: 'Upcoming tasks with checkboxes' },
  cal: { title: 'Calendar', icon: Calendar, color: 'red', sizes: ['M', 'L'], description: 'Next events today' },
  focus: { title: 'Focus', icon: Timer, color: 'coral', sizes: ['S', 'M'], description: 'Active focus timer' },
  weather: { title: 'Weather', icon: CloudSun, color: 'blue', sizes: ['S', 'M'], description: 'Temperature and forecast' },
  mail: { title: 'Mail', icon: Mail, color: 'violet', sizes: ['M', 'L'], description: 'Latest unread emails' },
  proj: { title: 'Projects', icon: Folder, color: 'green', sizes: ['M', 'L'], description: 'Progress across projects' },
  notes: { title: 'Notes', icon: NotebookText, color: 'orange', sizes: ['S', 'M'], description: 'Your most recent notes' },
  fin: { title: 'Finances', icon: Wallet, color: 'green', sizes: ['S', 'M'], description: 'Balance and spending' },
  goals: { title: 'Goals', icon: Target, color: 'violet', sizes: ['S', 'M'], description: 'Personal goals and progress' },
}

export const SIZE_NAME: Record<WidgetSize, string> = { S: 'Small', M: 'Medium', L: 'Large' }

export const DEFAULT_MOBILE_WIDGETS: MobileWidget[] = [['today', 'M'], ['focus', 'S'], ['weather', 'S'], ['cal', 'M'], ['mail', 'M'], ['notes', 'S'], ['fin', 'S'], ['proj', 'M']]

const WIDGETS_KEY = 'aelys.mobile.widgets.v1'

export function readMobileWidgets(): MobileWidget[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(WIDGETS_KEY) || 'null')
    if (Array.isArray(stored)) return stored.filter((entry): entry is MobileWidget => Array.isArray(entry) && entry[0] in MOBILE_CATALOG && MOBILE_CATALOG[entry[0] as MobileWidgetId].sizes.includes(entry[1]))
  } catch {
    // Unreadable storage falls back to the default set.
  }
  return DEFAULT_MOBILE_WIDGETS.map((entry) => [...entry] as MobileWidget)
}

export function saveMobileWidgets(widgets: MobileWidget[]) {
  try { window.localStorage.setItem(WIDGETS_KEY, JSON.stringify(widgets)) } catch { /* the layout still applies for this session */ }
}

// Rows each widget shows per size.
export const ROWS: Partial<Record<MobileWidgetId, Partial<Record<WidgetSize, number>>>> = {
  today: { M: 3, L: 5 }, cal: { M: 3, L: 4 }, mail: { M: 2, L: 4 }, proj: { M: 2, L: 4 }, notes: { S: 1, M: 3 }, goals: { S: 2, M: 3 },
}

export const MOBILE_MAIL = [
  { from: 'Google', subject: 'Sign-in confirmation for your account', when: '09:24', letter: 'G', bg: '#4285F4' },
  { from: 'Notion', subject: 'Weekly digest — 5 new pages', when: 'Tue', letter: 'N', bg: '#1C1B22' },
  { from: 'Telegram', subject: 'Ali: home screen mockups', when: 'Tue', letter: 'T', bg: '#229ED9' },
  { from: 'GitHub', subject: 'PR #142 is ready for review', when: 'Mon', letter: 'G', bg: '#24292F' },
]

export const MOBILE_PROJECTS: { title: string; sub: string; pct: number; color: AccentKey; icon: LucideIcon }[] = [
  { title: 'Aelys', sub: '12 tasks · 2 sessions', pct: 64, color: 'violet', icon: Sparkles },
  { title: 'BYTAN', sub: '8 tasks', pct: 37, color: 'blue', icon: Presentation },
  { title: 'SDU Utilities', sub: '6 tasks', pct: 20, color: 'green', icon: Wrench },
  { title: 'Study', sub: '8 tasks', pct: 37, color: 'orange', icon: GraduationCap },
]

export const MOBILE_NOTES = [
  { title: 'Design ideas', when: '2h', text: 'A new take on the home screen with an atmospheric photo.' },
  { title: 'Release plan', when: '5h', text: 'Milestones and key dates for v1.0.' },
  { title: 'Lecture notes', when: '1d', text: 'Product design basics and metrics.' },
]

export const MOBILE_GOALS = [{ title: 'Read 2 books', pct: 50 }, { title: 'Workout 3× a week', pct: 67 }, { title: 'Ship Aelys v1.0', pct: 64 }]

export const MOBILE_FORECAST: { hour: string; icon: LucideIcon; temp: string }[] = [
  { hour: '15:00', icon: CloudSun, temp: '14°' }, { hour: '18:00', icon: CloudDrizzle, temp: '12°' }, { hour: '21:00', icon: CloudRain, temp: '10°' }, { hour: 'Thu', icon: Sun, temp: '16°' },
]

export const FIN_BARS = [10, 14, 12, 18, 22, 26, 32]

export const FIN_SPEND = [{ title: 'Food', value: '21 400 ₸', color: '#EA6A1A' }, { title: 'Transport', value: '8 900 ₸', color: '#2F6FE4' }, { title: 'Subscriptions', value: '6 350 ₸', color: '#6A4CF2' }]

export const QUICK_ACTIONS: { title: string; icon: LucideIcon; color: AccentKey }[] = [
  { title: 'Find a task', icon: CircleDot, color: 'red' },
  { title: 'Schedule', icon: Calendar, color: 'blue' },
  { title: 'Sort inbox', icon: Sparkles, color: 'violet' },
  { title: 'Plan my day', icon: Lightbulb, color: 'orange' },
  { title: 'Analyze data', icon: ChartColumn, color: 'green' },
]

export const DEFAULT_QUICK_ACTIONS = [true, true, true, true, false]

export const CHAT_CONTEXT: { value: string; sub: string; icon: LucideIcon; color: AccentKey }[] = [
  { value: '5 tasks', sub: 'due today', icon: SquareCheck, color: 'blue' },
  { value: '2 meetings', sub: 'in calendar', icon: Calendar, color: 'violet' },
  { value: 'Focus', sub: '18:00 – 19:00', icon: Target, color: 'green' },
  { value: '+14°', sub: 'Rain tonight', icon: CloudSun, color: 'orange' },
]

export const CHAT_PLAN: { range: string; title: string; color: AccentKey; tag: string }[] = [
  { range: '10:00 – 11:00', title: 'Team call', color: 'blue', tag: '' },
  { range: '12:00 – 15:00', title: 'Work on the BYTAN deck', color: 'violet', tag: 'Task' },
  { range: '15:00 – 16:00', title: 'Workout', color: 'orange', tag: 'Personal' },
  { range: '16:00 – 18:00', title: 'Pay internet bill', color: 'gray', tag: 'Task' },
  { range: '18:00 – 19:00', title: 'Deep work', color: 'green', tag: 'Focus' },
]

export const CHAT_ACTIONS: { title: string; sub: string; icon: LucideIcon; color: string; bg: string }[] = [
  { title: 'Create task', sub: 'Pay internet bill today at 16:00', icon: SquareCheck, color: '#2F6FE4', bg: '#EAF0FD' },
  { title: 'Add to calendar', sub: 'Block time for the presentation', icon: Calendar, color: '#6A4CF2', bg: '#EFEBFD' },
  { title: 'Show #BYTAN notes', sub: 'Ideas, files and notes', icon: FileText, color: '#B45F06', bg: '#FDF3E2' },
]
