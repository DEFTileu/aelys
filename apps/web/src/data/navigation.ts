import type { RoutePath } from '../types'

export type NavItem = {
  label: string
  path: RoutePath
  icon: string
  badge?: string
}

export const primaryNav: NavItem[] = [
  { label: 'Today', path: '/', icon: 'home' },
  { label: 'AI Chat', path: '/ai', icon: 'sparkles' },
  { label: 'Tasks', path: '/tasks', icon: 'check-square' },
  { label: 'Calendar', path: '/calendar', icon: 'calendar' },
  { label: 'Projects', path: '/projects', icon: 'folder' },
  { label: 'Notes', path: '/notes', icon: 'note' },
]

export const appNav: NavItem[] = [
  { label: 'Mail', path: '/mail', icon: 'mail' },
  { label: 'Finance', path: '/finance', icon: 'wallet' },
  { label: 'Timer', path: '/timer', icon: 'timer' },
  { label: 'Developer Hub', path: '/developer', icon: 'terminal' },
  { label: 'Automation', path: '/automation', icon: 'workflow' },
]

export const utilityNav: NavItem[] = [
  { label: 'Search', path: '/search', icon: 'search' },
  { label: 'Settings', path: '/settings', icon: 'settings' },
]
