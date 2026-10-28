import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Calendar, ChevronRight, Folder, Mail, NotebookText, RefreshCw, Search, SquareCheck, Terminal, Timer, Wallet, Workflow, type LucideIcon } from 'lucide-react'
import type { ApiStatus, RoutePath } from '../types'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { ScreenToolbar, SegmentedTabs } from '../components/ScreenToolbar'
import { StateCard } from '../components/StateCard'
import { navigate } from '../lib/router'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import './desktop/module.css'

export type ModuleConfig = {
  path: RoutePath
  label: string
  icon: LucideIcon
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
  developer: { path: '/developer', label: 'Developer Hub', icon: Terminal, eyebrow: 'Local runtime', description: 'A safe home for connected project repositories and agent sessions.', action: 'Connect Mac', emptyTitle: 'Mac runtime is offline', emptyDescription: 'Full Claude Code and Codex CLI transcripts stay on Mac and are never fabricated in the web client.' },
  automation: { path: '/automation', label: 'Automation', icon: Workflow, eyebrow: 'Rules', description: 'Review policy checked triggers, conditions and actions.', action: 'New rule', emptyTitle: 'No automations configured', emptyDescription: 'Automation rules will be listed after the policy backed API is connected.' },
}

function statusForContent(apiStatus: ApiStatus): ApiStatus {
  return apiStatus === 'ready' ? 'empty' : apiStatus
}

function makeOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function ModuleView({ config, apiStatus }: { config: ModuleConfig; apiStatus: ApiStatus }) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [items, setItems] = useState<readonly Record<string, unknown>[]>([])
  const [contentStatus, setContentStatus] = useState<ApiStatus>(statusForContent(apiStatus))
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [actionMessage, setActionMessage] = useState('')

  const load = async () => {
    if (apiStatus !== 'ready') { setContentStatus(apiStatus); return }
    setContentStatus('loading')
    try {
      const client = getSharedApiClient()
      const value = config.path === '/projects' ? await client.projects() : config.path === '/notes' ? await client.notes() : config.path === '/tasks' ? await client.tasks() : config.path === '/calendar' ? await client.calendarEvents() : config.path === '/mail' ? await client.mailMessages() : config.path === '/finance' ? await client.financeTransactions() : config.path === '/timer' ? await client.focusSessions() : config.path === '/automation' ? await client.automations() : config.path === '/developer' ? await client.agentSessions() : []
      setItems(value as unknown as readonly Record<string, unknown>[])
      setContentStatus('ready')
    } catch {
      setContentStatus(navigator.onLine ? 'error' : 'offline')
    }
  }

  useEffect(() => { void load() }, [apiStatus, config.path])

  // Pill tabs come from the statuses the API actually returned, never from invented categories.
  const statuses = useMemo(() => [...new Set(items.map((item) => String(item.status ?? '')).filter(Boolean))], [items])
  const filtering = query.trim() !== '' || statusFilter !== 'All'
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => (statusFilter === 'All' || String(item.status ?? '') === statusFilter) && (!needle || Object.values(item).some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))))
  }, [items, query, statusFilter])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    setActionMessage('')
    try {
      const client = getSharedApiClient()
      const operationId = makeOperationId()
      const offlineOptions = (value: Record<string, unknown>) => ({
        idempotencyKey: operationId,
        offlineEntityKey: `pending:${config.path.slice(1)}:${operationId}`,
        offlineEntityValue: { pending: true, ...value },
      })
      if (config.path === '/projects') {
        const value = { name: title.trim() }
        await client.createProject(value, offlineOptions(value))
      }
      if (config.path === '/notes') {
        const value = { title: title.trim(), markdown_body: '' }
        await client.createNote(value, offlineOptions(value))
      }
      if (config.path === '/tasks') {
        const value = { title: title.trim() }
        await client.createTask(value, offlineOptions(value))
      }
      setTitle(''); setFormOpen(false); await load()
    } catch (error) {
      if (error instanceof OfflineQueuedError) setActionMessage('Saved to this device and queued for sync.')
      else if (error instanceof ApiError) setActionMessage(`${error.code}: ${error.message}`)
      else setActionMessage('Could not save this item.')
    }
  }

  const itemLabel = (item: Record<string, unknown>) => String(item.name ?? item.title ?? item.subject ?? item.provider ?? item.id ?? 'Untitled')
  const itemMeta = (item: Record<string, unknown>) => String(item.description ?? item.status ?? item.occurred_at ?? item.starts_at ?? item.created_at ?? '')
  const ModuleIcon = config.icon
  return <div className={`mod-screen ${config.canCreate ? '' : 'mod-screen--locked'}`}>
    <ScreenToolbar
      tabs={statuses.length > 1 ? <SegmentedTabs tabs={['All', ...statuses].map((status) => ({ id: status, label: status }))} value={statusFilter} onChange={setStatusFilter} label="Filter by status" /> : undefined}
      placeholder={`Ask Aelys about your ${config.label.toLowerCase()}…`}
      primary={config.action}
      onPrimary={config.canCreate ? () => setFormOpen(true) : undefined}
      onAsk={() => navigate('/ai')}
    />
    <div className="mod-body">
      <div className="mod-bar">
        <label className="mod-field"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${config.label.toLowerCase()}…`} aria-label={`Search ${config.label}`} /></label>
        <span className="mod-bar__spacer" />
        <ApiStatusPill status={apiStatus} />
        <button type="button" className="mod-link" onClick={() => navigate('/settings')}>Connection settings</button>
      </div>
      {formOpen && <form className="mod-create" onSubmit={create}><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Name your ${config.label.toLowerCase().replace(/s$/, '')}`} aria-label={`New ${config.label}`} /><button className="mod-btn mod-btn--primary" type="submit">Save</button><button className="mod-btn" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
      {actionMessage && <p className="mod-note" role="status">{actionMessage}</p>}
      {contentStatus === 'ready' && visibleItems.length > 0 ? <div className="mod-card">{visibleItems.map((item) => <article className="mod-row" key={String(item.id ?? `${itemLabel(item)}-${itemMeta(item)}`)}><span className="mod-row__icon"><ModuleIcon size={17} aria-hidden="true" /></span><span className="mod-row__body"><strong className="mod-row__title">{itemLabel(item)}</strong><small className="mod-row__meta">{itemMeta(item)}</small></span>{item.version ? <span className="mod-row__badge">v{String(item.version)}</span> : null}</article>)}</div> : contentStatus === 'empty' || (contentStatus === 'ready' && visibleItems.length === 0) ? <StateCard status="empty" title={filtering ? 'No matching records' : config.emptyTitle} description={filtering ? 'Try a different search term or status.' : config.emptyDescription} action={<button type="button" className="mod-link" onClick={() => navigate('/settings')}>Check API settings <ChevronRight size={14} /></button>} /> : <StateCard status={contentStatus} title={contentStatus === 'loading' ? 'Loading workspace' : contentStatus === 'offline' ? 'You are offline' : 'Could not load this app'} description={contentStatus === 'loading' ? 'Checking the configured API before loading this view.' : contentStatus === 'offline' ? 'Previously saved local settings remain available. Sync will resume when you are back online.' : 'The configured API did not respond. Check the base URL or try again.'} action={contentStatus === 'loading' ? undefined : <button type="button" className="mod-btn" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />Try again</button>} />}
    </div>
  </div>
}
