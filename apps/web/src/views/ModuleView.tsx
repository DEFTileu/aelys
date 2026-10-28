import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ApiStatus, RoutePath } from '../types'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { Icon } from '../components/Icon'
import { SectionHeading } from '../components/SectionHeading'
import { StateCard } from '../components/StateCard'
import { AiCommandBar } from '../components/AiCommandBar'
import { navigate } from '../lib/router'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'

export type ModuleConfig = {
  path: RoutePath
  label: string
  icon: Parameters<typeof Icon>[0]['name']
  eyebrow: string
  description: string
  action: string
  emptyTitle: string
  emptyDescription: string
  canCreate?: boolean
}

export const moduleConfigs: Record<string, ModuleConfig> = {
  projects: { path: '/projects', label: 'Projects', icon: 'folder', eyebrow: 'Workspace', description: 'Keep related work, notes and tasks in one context.', action: 'New project', emptyTitle: 'No projects yet', emptyDescription: 'Projects from the API will appear here once the workspace is connected.', canCreate: true },
  notes: { path: '/notes', label: 'Notes', icon: 'note', eyebrow: 'Knowledge', description: 'A quiet place for Markdown notes, links and revisions.', action: 'New note', emptyTitle: 'Your notes are empty', emptyDescription: 'Create a note locally or connect the API to load your existing knowledge.', canCreate: true },
  tasks: { path: '/tasks', label: 'Tasks', icon: 'check-square', eyebrow: 'Work queue', description: 'See what needs attention today and what is coming next.', action: 'New task', emptyTitle: 'No tasks to show', emptyDescription: 'The task list is empty until a connected source returns tasks.', canCreate: true },
  calendar: { path: '/calendar', label: 'Calendar', icon: 'calendar', eyebrow: 'Time', description: 'Plan events and reminders around the work that matters.', action: 'New event', emptyTitle: 'Nothing scheduled', emptyDescription: 'Events will appear after the calendar API is connected.' },
  mail: { path: '/mail', label: 'Mail', icon: 'mail', eyebrow: 'Communication', description: 'A model for messages and drafts, ready for a provider adapter.', action: 'Import mail', emptyTitle: 'Mail is not connected', emptyDescription: 'Aelys does not invent messages. Connect or import a provider when one is approved.' },
  finance: { path: '/finance', label: 'Finance', icon: 'wallet', eyebrow: 'Money', description: 'Track manual transactions, accounts and budgets with decimal-safe values.', action: 'Add transaction', emptyTitle: 'No transactions yet', emptyDescription: 'Your ledger will stay empty until a local or API source supplies transactions.' },
  timer: { path: '/timer', label: 'Timer', icon: 'timer', eyebrow: 'Focus', description: 'A durable focus timer that can be tied to a task or project.', action: 'Start timer', emptyTitle: 'Ready when you are', emptyDescription: 'No active focus session is stored locally yet.' },
  developer: { path: '/developer', label: 'Developer Hub', icon: 'terminal', eyebrow: 'Local runtime', description: 'A safe home for connected project repositories and agent sessions.', action: 'Connect Mac', emptyTitle: 'Mac runtime is offline', emptyDescription: 'Full Claude Code and Codex CLI transcripts stay on Mac and are never fabricated in the web client.' },
  automation: { path: '/automation', label: 'Automation', icon: 'workflow', eyebrow: 'Rules', description: 'Review policy checked triggers, conditions and actions.', action: 'New rule', emptyTitle: 'No automations configured', emptyDescription: 'Automation rules will be listed after the policy backed API is connected.' },
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

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) => Object.values(item).some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)))
  }, [items, query])

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
  return <div className="page page--module">
    <header className="page-header"><div className="page-header__title"><span className="page-icon"><Icon name={config.icon} size={21} /></span><div><p className="eyebrow">{config.eyebrow}</p><h1>{config.label}</h1><p>{config.description}</p></div></div><button className="button button--primary" onClick={() => setFormOpen(true)} disabled={!config.canCreate} title={config.canCreate ? config.action : 'This entry point is not wired yet'}><Icon name="plus" size={17} />{config.action}</button></header>
    <div className="context-strip"><ApiStatusPill status={apiStatus} /><span className="context-strip__copy">The web shell is ready for the shared client boundary.</span></div>
    <div className="module-toolbar"><label className="search-field"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${config.label.toLowerCase()}…`} aria-label={`Search ${config.label}`} /></label><button className="button button--quiet"><Icon name="sliders" size={17} />Filter</button></div>
    <section className="module-surface"><SectionHeading title={query ? `Results for “${query}”` : 'Overview'} action={<button className="text-button" onClick={() => navigate('/settings')}>Connection settings</button>} />{formOpen && <form className="inline-create" onSubmit={create}><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Name your ${config.label.toLowerCase().replace(/s$/, '')}`} aria-label={`New ${config.label}`} /><button className="button button--primary" type="submit">Save</button><button className="button button--quiet" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}{actionMessage && <p className="save-note" role="status">{actionMessage}</p>}{contentStatus === 'ready' && visibleItems.length > 0 ? <div className="record-list">{visibleItems.map((item) => <article className="record-row" key={String(item.id ?? `${itemLabel(item)}-${itemMeta(item)}`)}><span className="record-row__icon"><Icon name={config.icon} size={16} /></span><span className="record-row__body"><strong>{itemLabel(item)}</strong><small>{itemMeta(item)}</small></span><span className="record-row__version">{item.version ? `v${String(item.version)}` : ''}</span></article>)}</div> : contentStatus === 'empty' || (contentStatus === 'ready' && visibleItems.length === 0) ? <StateCard status="empty" title={query ? 'No matching records' : config.emptyTitle} description={query ? 'Try a different search term.' : config.emptyDescription} action={<button className="text-button" onClick={() => navigate('/settings')}>Check API settings <Icon name="chevron-right" size={14} /></button>} /> : <StateCard status={contentStatus} title={contentStatus === 'loading' ? 'Loading workspace' : contentStatus === 'offline' ? 'You are offline' : 'Could not load this app'} description={contentStatus === 'loading' ? 'Checking the configured API before loading this view.' : contentStatus === 'offline' ? 'Previously saved local settings remain available. Sync will resume when you are back online.' : 'The configured API did not respond. Check the base URL or try again.'} action={<button className="text-button" onClick={() => void load()}><Icon name="refresh" size={14} />Try again</button>} />}</section>
    <div className="module-ai"><AiCommandBar compact /></div>
  </div>
}
