import { BookOpen, Calendar, CalendarDays, ChartColumn, Code, FileText, Folder, Footprints, House, Lightbulb, Mail, Plane, Plus, Search, Sparkles, SquareCheck, Sun, Target, Users, Utensils, Video } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Demo data for the AI Chat screen, taken from the desktop design script (chat section).
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; time: string }
export type ChatConversation = { title: string; preview: string; when: string; icon: LucideIcon; color: string; active?: boolean }
export type ChatGroup = { title: string; items: ChatConversation[] }
export type ChatPlanItem = { range: string; title: string; detail: string; icon: LucideIcon; color: string; action: string; actionIcon: LucideIcon; actionColor: string; primary?: boolean }
export type ChatShortcut = { title: string; detail: string; icon: LucideIcon; color: string }

export const chatMessages: ChatMessage[] = [
  { id: 'user-plan', role: 'user', text: 'Make a plan for today based on my tasks, calendar and focus. I want to be productive, but without overloading. Main focus — studies and the Aelys project.', time: '10:24' },
  { id: 'assistant-plan', role: 'assistant', text: 'Of course, Tileuzhan! I analyzed your tasks, calendar and current focus. Here’s a plan for today — balanced, realistic and aligned with your goals.', time: '10:24' }
]

export const chatGroups: ChatGroup[] = [
  { title: 'Today', items: [
    { title: 'Plan for today', preview: 'Make a plan for today with my tasks…', when: '10:24', icon: Sun, color: '#D97706', active: true }
  ] },
  { title: 'This week', items: [
    { title: 'Plan for the week', preview: 'Help me plan the week', when: 'Tue', icon: CalendarDays, color: '#D93636' },
    { title: 'Email draft', preview: 'Write an invitation email…', when: 'Tue', icon: Mail, color: '#6A4CF2' },
    { title: 'Project ideas', preview: 'Suggest ideas for my project…', when: 'Tue', icon: FileText, color: '#2F6FE4' },
    { title: 'Study analysis', preview: 'How can I improve my grades?', when: 'Oct 26', icon: ChartColumn, color: '#6A4CF2' },
    { title: 'Monthly goals', preview: 'Help me set clear goals…', when: 'Oct 25', icon: Target, color: '#D93636' },
    { title: 'Lecture summary', preview: 'Make a short summary', when: 'Oct 24', icon: BookOpen, color: '#2F6FE4' },
    { title: 'Code help', preview: 'Explain this React error', when: 'Oct 23', icon: Code, color: '#6A4CF2' },
    { title: 'Trip plan', preview: 'Plan a route around Almaty', when: 'Oct 22', icon: Plane, color: '#2F6FE4' }
  ] }
]

export const chatPlan: ChatPlanItem[] = [
  { range: '10:00 – 11:00', title: 'Team call', detail: 'Discuss Aelys progress', icon: Users, color: '#6A4CF2', action: 'Join', actionIcon: Video, actionColor: '#5132D6', primary: true },
  { range: '11:00 – 13:00', title: 'Aelys development', detail: 'Build the AI Chat block', icon: Code, color: '#0F9488', action: 'Open project', actionIcon: Folder, actionColor: '#2F6FE4' },
  { range: '13:00 – 14:00', title: 'Lunch', detail: 'Time to rest', icon: Utensils, color: '#D97706', action: 'Add to calendar', actionIcon: Calendar, actionColor: '#D93636' },
  { range: '14:00 – 15:30', title: 'Study: APIs & integrations', detail: 'Read materials, write a summary', icon: BookOpen, color: '#2F6FE4', action: 'Create task', actionIcon: Plus, actionColor: '#2F6FE4' },
  { range: '15:30 – 16:00', title: 'Workout', detail: 'Training or a walk', icon: Footprints, color: '#E2553F', action: 'Add to calendar', actionIcon: Calendar, actionColor: '#D93636' },
  { range: '16:00 – 18:00', title: 'Write an article', detail: 'Ideas and notes for the blog', icon: FileText, color: '#14966C', action: 'Create task', actionIcon: Plus, actionColor: '#2F6FE4' },
  { range: '18:00 – 19:00', title: 'Personal errands', detail: 'Mail and household tasks', icon: House, color: '#6A4CF2', action: 'Show task', actionIcon: SquareCheck, actionColor: '#2F6FE4' },
  { range: '19:00 – 21:00', title: 'Read a book', detail: 'Growth and rest', icon: BookOpen, color: '#2F6FE4', action: 'Add to calendar', actionIcon: Calendar, actionColor: '#D93636' }
]

export const chatExtras: ChatShortcut[] = [
  { title: 'Evening reflection', detail: 'Tomorrow, 20:30', icon: Lightbulb, color: '#D97706' },
  { title: 'Weekly plan', detail: 'From current tasks', icon: Target, color: '#D93636' },
  { title: 'Productivity', detail: 'View statistics', icon: ChartColumn, color: '#14966C' }
]

export const chatContextTabs = ['Today', 'Week', 'Projects']

export const chatContext: ChatShortcut[] = [
  { title: 'Tasks for today', detail: '5 tasks', icon: SquareCheck, color: '#14966C' },
  { title: 'Calendar', detail: '4 events', icon: Calendar, color: '#D93636' },
  { title: 'Current focus', detail: 'Studies & Aelys', icon: Target, color: '#D9367E' },
  { title: 'Active projects', detail: '3 projects', icon: Folder, color: '#2F6FE4' }
]

export const chatQuickActions: { title: string; icon: LucideIcon; color: string }[] = [
  { title: 'Create task', icon: Plus, color: '#1C1B22' },
  { title: 'Add to calendar', icon: Calendar, color: '#D93636' },
  { title: 'Find information', icon: Search, color: '#2F6FE4' },
  { title: 'Generate content', icon: Sparkles, color: '#6A4CF2' }
]

export const chatPrompts: { title: string; icon: LucideIcon; color: string }[] = [
  { title: 'Weekly plan', icon: Calendar, color: '#D93636' },
  { title: 'Inbox review', icon: Mail, color: '#6A4CF2' },
  { title: 'Notes summary', icon: FileText, color: '#3A3640' }
]
