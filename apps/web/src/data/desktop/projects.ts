import { GraduationCap, House, Presentation, Sparkles, Sprout, Wrench, type LucideIcon } from 'lucide-react'

export type ProjectTab = 'all' | 'active' | 'archived'
export type ProjectStatus = 'Active' | 'Paused'

export type ProjectCard = {
  title: string
  subtitle: string
  pct: number
  color: string
  icon: LucideIcon
  next: string
  due: string
  done: string
  status: ProjectStatus
}

export const projectTabs: { id: ProjectTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
]

export const projectToolbar = {
  placeholder: 'Ask Aelys about a project…',
  primary: 'New project',
}

export const projectCards: ProjectCard[] = [
  { title: 'Aelys', subtitle: 'Personal OS · 12 tasks', pct: 64, color: '#6A4CF2', icon: Sparkles, next: 'Build the AI Chat block', due: 'Due Nov 15', done: '8 / 12', status: 'Active' },
  { title: 'BYTAN', subtitle: 'Startup deck · 8 tasks', pct: 37, color: '#2F6FE4', icon: Presentation, next: 'Finish presentation slides', due: 'Due Oct 30', done: '3 / 8', status: 'Active' },
  { title: 'SDU Utilities', subtitle: 'Student tools · 5 tasks', pct: 20, color: '#14966C', icon: Wrench, next: 'Set up the schedule parser', due: 'Due Dec 1', done: '1 / 5', status: 'Active' },
  { title: 'Study', subtitle: 'Semester · 8 tasks', pct: 37, color: '#D97706', icon: GraduationCap, next: 'Lecture summary: APIs', due: 'Due Oct 29', done: '3 / 8', status: 'Active' },
  { title: 'Personal', subtitle: 'Life admin · 6 tasks', pct: 50, color: '#D9367E', icon: House, next: 'Pay internet bill', due: 'Today', done: '3 / 6', status: 'Active' },
  { title: 'Growth', subtitle: 'Learning · 3 tasks', pct: 33, color: '#0F9488', icon: Sprout, next: 'Read “Designing Habits”', due: 'No deadline', done: '1 / 3', status: 'Paused' },
]

export const projectStatusStyle: Record<ProjectStatus, { bg: string; fg: string }> = {
  Active: { bg: '#DCF5EC', fg: '#0E7A57' },
  Paused: { bg: '#F1EDEA', fg: '#4F4A56' },
}
