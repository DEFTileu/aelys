// Demo content for the home screen, ported from the Claude Design "Aelys Desktop" script.
import { CalendarCheck, ChartColumn, Check, CircleDot, CloudDrizzle, CloudRain, CloudSun, CloudUpload, Ellipsis, FileText, FolderOpen, Mail, Presentation, Sparkles, Sun, Wrench, type LucideIcon } from 'lucide-react'

export const ACCENT = {
  violet: '#6A4CF2',
  blue: '#2F6FE4',
  green: '#14966C',
  orange: '#D97706',
  coral: '#E2553F',
  pink: '#D9367E',
  teal: '#0F9488',
  red: '#D93636',
  gray: '#6B6672',
} as const

export type AccentKey = keyof typeof ACCENT

export function accentOf(key: AccentKey) {
  const c = ACCENT[key]
  return { c, soft: `${c}1A` }
}

// [background, left border] for calendar blocks.
export const EVENT_TINT = {
  blue: ['#E4EEFD', '#4A8EF0'],
  violet: ['#EEE8FD', '#8B6CF0'],
  coral: ['#FDE6E1', '#F07362'],
  green: ['#DCF5EC', '#36BE8A'],
  yellow: ['#FDF1D9', '#EFB23E'],
} as const

export type EventTint = keyof typeof EVENT_TINT

export const FOCUS_SESSION_SECONDS = 1500
export const FOCUS_START_SECONDS = 1122

export const HOME_CHIPS: { label: string; icon: LucideIcon; color: string }[] = [
  { label: 'Plan my day', icon: CalendarCheck, color: '#2F6FE4' },
  { label: 'Find a task', icon: CircleDot, color: '#D93636' },
  { label: 'Continue project', icon: FolderOpen, color: '#6A4CF2' },
  { label: 'Sort inbox', icon: Mail, color: '#D9367E' },
  { label: 'Analyze data', icon: ChartColumn, color: '#0F9488' },
  { label: 'More', icon: Ellipsis, color: '#3A3640' },
]

export const TODAY_TASKS = [
  { title: 'Team call', time: '10:00' },
  { title: 'API review', time: '12:00' },
  { title: 'Pay internet bill', time: '15:00' },
  { title: 'Workout', time: '18:00' },
  { title: 'Read a book', time: '21:00' },
]

export const CALENDAR_TODAY: { time: string; end: string; title: string; tint: EventTint }[] = [
  { time: '10:00', end: '11:00', title: 'Team call', tint: 'blue' },
  { time: '12:00', end: '13:00', title: 'API review', tint: 'violet' },
  { time: '15:00', end: '16:00', title: 'Gym', tint: 'coral' },
  { time: '18:00', end: '19:00', title: 'Workout', tint: 'green' },
]

export const WEATHER_FORECAST: { time: string; icon: LucideIcon; temp: string }[] = [
  { time: '15:00', icon: CloudSun, temp: '+14°' },
  { time: '18:00', icon: CloudDrizzle, temp: '+12°' },
  { time: '21:00', icon: CloudRain, temp: '+10°' },
  { time: 'Thu', icon: Sun, temp: '+16°' },
]

export const HOME_PROJECTS: { title: string; subtitle: string; pct: number; color: AccentKey; icon: LucideIcon }[] = [
  { title: 'Aelys', subtitle: '12 tasks · 2 sessions', pct: 64, color: 'violet', icon: Sparkles },
  { title: 'BYTAN', subtitle: '8 tasks', pct: 37, color: 'blue', icon: Presentation },
  { title: 'SDU Utilities', subtitle: '5 tasks', pct: 20, color: 'green', icon: Wrench },
]

export const RECENT_NOTES: { title: string; when: string; color: AccentKey }[] = [
  { title: 'Design ideas', when: '2h ago', color: 'blue' },
  { title: 'Release plan', when: '5h ago', color: 'violet' },
  { title: 'Lecture notes', when: '1d ago', color: 'orange' },
  { title: 'Reading list', when: '3d ago', color: 'red' },
]

export const FINANCE = {
  balance: '48 250 ₸',
  change: '+12% vs September',
  bars: [10, 14, 12, 18, 22, 26, 32],
  spending: [
    { title: 'Food', amount: '21 400 ₸', color: '#EA6A1A' },
    { title: 'Transport', amount: '8 900 ₸', color: '#2F6FE4' },
    { title: 'Subscriptions', amount: '6 350 ₸', color: '#6A4CF2' },
    { title: 'Entertainment', amount: '4 200 ₸', color: '#D9367E' },
  ],
}

export const KNOWLEDGE_DOCS: { title: string; meta: string; color: AccentKey }[] = [
  { title: 'Sync v2 — questions', meta: '12 pages', color: 'green' },
  { title: 'Sync protocol', meta: '8 pages', color: 'red' },
  { title: 'Data model', meta: '5 pages', color: 'violet' },
  { title: 'Aelys architecture', meta: '14 pages', color: 'blue' },
]

export const MAIL_ROWS: { from: string; subject: string; when: string; color: AccentKey }[] = [
  { from: 'SDU', subject: 'Schedule update', when: '10:24', color: 'blue' },
  { from: 'GitHub', subject: 'Security alert in repository', when: '09:15', color: 'violet' },
  { from: 'Notion', subject: 'Weekly digest — 5 new pages', when: 'Tue', color: 'green' },
  { from: 'Team', subject: 'Meeting invitation', when: 'Tue', color: 'orange' },
]

export const ACTIVITY: { title: string; subtitle: string; when: string; icon: LucideIcon; color: AccentKey }[] = [
  { title: 'New email', subtitle: 'Meeting invitation', when: '10 min', icon: Mail, color: 'coral' },
  { title: 'Task completed', subtitle: 'Pay internet bill', when: '2h', icon: Check, color: 'green' },
  { title: 'Note updated', subtitle: 'Design ideas', when: '4h', icon: FileText, color: 'blue' },
  { title: 'File uploaded', subtitle: 'Aelys Presentation.pdf', when: '6h', icon: CloudUpload, color: 'violet' },
]
