import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import type { ModuleConfig } from './moduleConfigs'

function statusForContent(apiStatus: ApiStatus): ApiStatus {
  return apiStatus === 'ready' ? 'empty' : apiStatus
}

function makeOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useModule(config: ModuleConfig, apiStatus: ApiStatus) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [items, setItems] = useState<readonly Record<string, unknown>[]>([])
  const [contentStatus, setContentStatus] = useState<ApiStatus>(statusForContent(apiStatus))
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [loadBlocked, setLoadBlocked] = useState(false)

  const load = async () => {
    if (apiStatus !== 'ready') { setContentStatus(apiStatus); return }
    setContentStatus('loading'); setLoadBlocked(false)
    try {
      const client = getSharedApiClient()
      const value = config.path === '/projects' ? await client.projects() : config.path === '/notes' ? await client.notes() : config.path === '/tasks' ? await client.tasks() : config.path === '/calendar' ? await client.calendarEvents() : config.path === '/mail' ? await client.mailMessages() : config.path === '/finance' ? await client.financeTransactions() : config.path === '/timer' ? await client.focusSessions() : config.path === '/automation' ? await client.automations() : config.path === '/developer' ? await client.agentSessions() : []
      setItems(value as unknown as readonly Record<string, unknown>[])
      setContentStatus('ready')
    } catch (error) {
      setLoadBlocked(error instanceof ApiError && (error.status === 403 || /POLICY|FORBIDDEN|PERMISSION/.test(error.code)))
      setContentStatus(navigator.onLine ? 'error' : 'offline')
    }
  }

  useEffect(() => { void load() }, [apiStatus, config.path])

  // Pill tabs come from the statuses the API actually returned, never from invented categories.
  const itemStatus = (item: Record<string, unknown>) => config.path === '/developer' ? String(item.state ?? '') : config.path === '/automation' ? item.enabled === true ? 'Enabled' : item.enabled === false ? 'Disabled' : '' : String(item.status ?? '')
  const statuses = useMemo(() => [...new Set(items.map(itemStatus).filter(Boolean))], [items, config.path])
  const filtering = query.trim() !== '' || statusFilter !== 'All'
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => (statusFilter === 'All' || itemStatus(item) === statusFilter) && (!needle || Object.values(item).some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))))
  }, [items, query, statusFilter, config.path])

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
  return {
    apiStatus, config, query, setQuery, statusFilter, setStatusFilter, contentStatus, formOpen, setFormOpen, title, setTitle,
    actionMessage, loadBlocked, load, statuses, filtering, visibleItems, create, itemLabel, itemMeta, itemStatus, ModuleIcon,
  }
}
