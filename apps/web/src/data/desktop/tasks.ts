// Demo data for the Tasks screen, ported from the Aelys Desktop design script.

export type TaskIcon =
  | 'calendar'
  | 'calendar-days'
  | 'folder'
  | 'list-filter'
  | 'sparkles'
  | 'house'
  | 'graduation-cap'
  | 'wallet'
  | 'sprout'
  | 'list-checks'
  | 'alarm-clock'
  | 'flag'
  | 'user'
  | 'check'

export type TaskTone = { c: string; soft: string; ink: string }

export function tone(c: string): TaskTone {
  return { c, soft: c + '1A', ink: c }
}

export type TagKey = 'aelys' | 'personal' | 'study'
export type TaskTag = TaskTone & { t: string; icon: TaskIcon }

export const TASK_TAGS: Record<TagKey, TaskTag> = {
  aelys: { t: 'Aelys', icon: 'sparkles', ...tone('#6A4CF2') },
  personal: { t: 'Personal', icon: 'house', ...tone('#D97706') },
  study: { t: 'Study', icon: 'graduation-cap', ...tone('#2F6FE4') },
}

export type TaskPriority = 'Low' | 'Medium' | 'High'
export type TodayTask = { title: string; description: string; tag: TagKey; time: string; flag: string; priority: TaskPriority }

export const TODAY_TASKS: TodayTask[] = [
  { title: 'Team call', tag: 'aelys', description: 'Discuss progress and the plan for the week', time: '10:00', flag: '#E87979', priority: 'Low' },
  { title: 'API review', tag: 'aelys', description: 'Review pull requests and give feedback', time: '12:00', flag: '#D93636', priority: 'High' },
  { title: 'Pay internet bill', tag: 'personal', description: 'Check the plan and renew', time: '15:00', flag: '#E0A321', priority: 'Medium' },
  { title: 'Prepare presentation', tag: 'study', description: 'Slides for Friday’s meeting', time: '18:00', flag: '#D93636', priority: 'High' },
  { title: 'Read a book', tag: 'personal', description: 'Continue “Designing Habits”', time: '21:00', flag: '#E0A321', priority: 'Medium' },
]

export type UpcomingItem = { title: string; tag: TagKey; time: string; flag: string }
export type UpcomingGroup = { day: string; sub: string; items: UpcomingItem[] }

export const UPCOMING_GROUPS: UpcomingGroup[] = [
  {
    day: 'Tomorrow',
    sub: ' · Thursday, October 29',
    items: [
      { title: 'Prepare project report', tag: 'aelys', time: '10:00', flag: '#EA6A1A' },
      { title: 'Meeting with mentor', tag: 'study', time: '14:00', flag: '#E0A321' },
      { title: 'Workout', tag: 'personal', time: '18:00', flag: '#E0A321' },
    ],
  },
  {
    day: 'Friday',
    sub: ' · October 30',
    items: [
      { title: 'Sprint planning', tag: 'aelys', time: '11:00', flag: '#D93636' },
      { title: 'Sort inbox', tag: 'personal', time: '16:00', flag: '#E0A321' },
    ],
  },
]

export type TaskFilter = { label: string; count: number; icon: TaskIcon; color: string; active?: boolean; warn?: boolean }

export const TASK_FILTERS: TaskFilter[] = [
  { label: 'All tasks', count: 24, icon: 'list-checks', color: '#5132D6', active: true },
  { label: 'Today', count: 5, icon: 'calendar', color: '#D93636' },
  { label: 'Overdue', count: 2, icon: 'alarm-clock', color: '#D93636', warn: true },
  { label: 'High priority', count: 6, icon: 'flag', color: '#D93636' },
  { label: 'Assigned to me', count: 24, icon: 'user', color: '#2F6FE4' },
  { label: 'Completed', count: 48, icon: 'check', color: '#14966C' },
]

export type TaskProject = TaskTone & { title: string; sub: string; pct: number; icon: TaskIcon }

export const TASK_PROJECTS: TaskProject[] = [
  { title: 'Aelys', sub: '12 tasks · 2 sessions', pct: 64, icon: 'sparkles', ...tone('#6A4CF2') },
  { title: 'Study', sub: '8 tasks', pct: 37, icon: 'graduation-cap', ...tone('#2F6FE4') },
  { title: 'Personal', sub: '6 tasks', pct: 50, icon: 'house', ...tone('#14966C') },
  { title: 'Finances', sub: '4 tasks', pct: 25, icon: 'wallet', ...tone('#D97706') },
  { title: 'Growth', sub: '3 tasks', pct: 33, icon: 'sprout', ...tone('#D9367E') },
]

export const TASK_TOTAL = 8
// Design script: completed count is the Today list's done count plus these 3 tasks, which are not listed.
export const TASK_STATS = { completedElsewhere: 3, inProgress: 2, overdue: 1 }
