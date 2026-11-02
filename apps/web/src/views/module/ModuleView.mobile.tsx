import { Plus, RefreshCw, Search } from '../../icons'
import type { ApiStatus } from '../../types'
import { ApiStatusPill } from '../../components/ApiStatusPill'
import { StateCard } from '../../components/StateCard'
import { navigate } from '../../lib/router'
import '../desktop/module.css'
import './module-mobile.css'
import { useModule } from './useModule'
import type { ModuleConfig } from './moduleConfigs'

// One list layout for every module: search, status chips, rows, and a create sheet opened from the FAB.
export function ModuleMobile({ config, apiStatus }: { config: ModuleConfig; apiStatus: ApiStatus }) {
  const { query, setQuery, statusFilter, setStatusFilter, statuses, contentStatus, visibleItems, filtering, load, itemStatus, ModuleIcon, formOpen, setFormOpen, title, setTitle, create, actionMessage, itemLabel, itemMeta, loadBlocked } = useModule(config, apiStatus)
  const developer = config.path === '/developer'
  const automation = config.path === '/automation'
  const rowTitle = (item: Record<string, unknown>) => developer ? String(item.adapter ?? 'Agent session') : automation ? String(item.name ?? 'Automation') : itemLabel(item)
  const rowMeta = (item: Record<string, unknown>) => developer ? [item.state, item.last_activity_at].filter(Boolean).join(' · ') : automation ? [item.trigger_kind, item.policy_ref ? `Policy: ${String(item.policy_ref)}` : null].filter(Boolean).join(' · ') : itemMeta(item)
  const rowBadge = (item: Record<string, unknown>) => itemStatus(item) || (item.version ? `v${String(item.version)}` : '')
  return <div className="module-m">
    <header className="module-m-head"><h1>{config.label}</h1>
      <div className="module-m-head__actions"><ApiStatusPill status={apiStatus} /><button type="button" className="module-m-icon" aria-label="Refresh" onClick={() => void load()}><RefreshCw size={18} aria-hidden="true" /></button></div></header>
    <label className="module-m-search"><Search size={18} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${config.label.toLowerCase()}…`} aria-label={`Search ${config.label}`} /></label>
    {statuses.length > 1 && <div className="module-m-chips" role="group" aria-label="Filter by status">{['All', ...statuses].map((status) => <button key={status} type="button" aria-pressed={statusFilter === status} onClick={() => setStatusFilter(status)}>{status}</button>)}</div>}
    {actionMessage && <p className="module-m-note" role="status">{actionMessage}</p>}
    {contentStatus === 'ready' && visibleItems.length > 0 ? <ul className="module-m-list">{visibleItems.map((item) => <li className="module-m-row" key={String(item.id ?? `${itemLabel(item)}-${itemMeta(item)}`)}>
        <span className="module-m-row__icon"><ModuleIcon size={18} aria-hidden="true" /></span>
        <span className="module-m-row__body"><strong>{rowTitle(item)}</strong><small>{rowMeta(item)}</small></span>
        {rowBadge(item) && <span className="module-m-row__badge">{rowBadge(item)}</span>}</li>)}</ul>
      : contentStatus === 'empty' || (contentStatus === 'ready' && !visibleItems.length) ? <StateCard status="empty" title={filtering ? 'No matching records' : config.emptyTitle} description={filtering ? 'Try a different search or status.' : config.emptyDescription} action={<button type="button" className="mod-link" onClick={() => navigate('/settings')}>Check API settings</button>} />
      : <StateCard status={contentStatus} title={contentStatus === 'loading' ? 'Loading' : loadBlocked ? 'Access restricted' : contentStatus === 'offline' ? 'You are offline' : 'Could not load'} description={contentStatus === 'loading' ? 'Loading records from the API.' : loadBlocked ? 'The request was denied. Check the owner session and applicable permissions.' : contentStatus === 'offline' ? 'Connect to load these records.' : 'Check the connection and try again.'} action={contentStatus === 'loading' ? undefined : <button type="button" className="mod-btn" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />Try again</button>} />}
    {config.canCreate && <button type="button" className="module-m-fab" aria-label={config.action} onClick={() => setFormOpen(true)}><Plus size={24} aria-hidden="true" /></button>}
    {formOpen && <div className="module-m-sheet-layer">
      <form className="module-m-sheet" role="dialog" aria-modal="true" aria-label={config.action} onSubmit={create}>
        <span className="module-m-sheet__grip" aria-hidden="true" />
        <h2>{config.action}</h2>
        <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Name your ${config.label.toLowerCase().replace(/s$/, '')}`} aria-label={`New ${config.label}`} />
        <div className="module-m-sheet__actions"><button type="button" className="module-m-btn" onClick={() => setFormOpen(false)}>Cancel</button><button type="submit" className="module-m-btn module-m-btn--primary">Save</button></div>
      </form></div>}
  </div>
}
