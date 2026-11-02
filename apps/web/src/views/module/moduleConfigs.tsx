import type { RoutePath } from '../../types'
import { Calendar, Folder, Mail, NotebookText, SquareCheck, Terminal, Timer, Wallet, Workflow, type AelysIconComponent } from '../../icons'
export type ModuleConfig = {
  path: RoutePath
  label: string
  icon: AelysIconComponent
  eyebrow: string
  description: string
  action: string
  emptyTitle: string
  emptyDescription: string
  canCreate?: boolean
}

export const moduleConfigs: Record<string, ModuleConfig> = {
  projects: { path: '/projects', label: 'Projects', icon: Folder, eyebrow: 'Workspace', description: 'Keep related work, notes and tasks in one context.', action: 'New project', emptyTitle: 'No projects yet', emptyDescription: 'Projects from the API will appear here once the workspace is connected.', canCreate: true },
  notes: { path: '/notes', label: 'Notes', icon: NotebookText, eyebrow: 'Knowledge', description: 'A quiet place for Markdown notes, links and revisions.', action: 'New note', emptyTitle: 'Your notes are empty', emptyDescription: 'Create a note locally or connect the API to load your existing knowledge.', canCreate: true },
  tasks: { path: '/tasks', label: 'Tasks', icon: SquareCheck, eyebrow: 'Work queue', description: 'See what needs attention today and what is coming next.', action: 'New task', emptyTitle: 'No tasks to show', emptyDescription: 'The task list is empty until a connected source returns tasks.', canCreate: true },
  calendar: { path: '/calendar', label: 'Calendar', icon: Calendar, eyebrow: 'Time', description: 'Plan events and reminders around the work that matters.', action: 'New event', emptyTitle: 'Nothing scheduled', emptyDescription: 'Events will appear after the calendar API is connected.' },
  mail: { path: '/mail', label: 'Mail', icon: Mail, eyebrow: 'Communication', description: 'A model for messages and drafts, ready for a provider adapter.', action: 'Import mail', emptyTitle: 'Mail is not connected', emptyDescription: 'Aelys does not invent messages. Connect or import a provider when one is approved.' },
  finance: { path: '/finance', label: 'Finance', icon: Wallet, eyebrow: 'Money', description: 'Track manual transactions, accounts and budgets with decimal-safe values.', action: 'Add transaction', emptyTitle: 'No transactions yet', emptyDescription: 'Your ledger will stay empty until a local or API source supplies transactions.' },
  timer: { path: '/timer', label: 'Timer', icon: Timer, eyebrow: 'Focus', description: 'A durable focus timer that can be tied to a task or project.', action: 'Start timer', emptyTitle: 'Ready when you are', emptyDescription: 'No active focus session is stored locally yet.' },
  developer: { path: '/developer', label: 'Developer Hub', icon: Terminal, eyebrow: 'Local runtime', description: 'A safe home for connected project repositories and agent sessions.', action: 'Connect Mac', emptyTitle: 'No sessions found', emptyDescription: 'Session metadata will appear here when available. Full transcripts stay on Mac.' },
  automation: { path: '/automation', label: 'Automation', icon: Workflow, eyebrow: 'Rules', description: 'Review policy checked triggers, conditions and actions.', action: 'New rule', emptyTitle: 'No automations configured', emptyDescription: 'Automation rules will be listed after the policy backed API is connected.' },
}
