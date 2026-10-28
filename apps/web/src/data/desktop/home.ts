import { CalendarCheck, ChartColumn, CircleDot, Ellipsis, FolderOpen, Mail, type LucideIcon } from 'lucide-react'

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
