import { ChevronRight, RefreshCw, Search } from '../../icons'
import type { ApiStatus } from '../../types'
import { ScreenToolbar, SegmentedTabs } from '../../components/ScreenToolbar'
import { StateCard } from '../../components/StateCard'
import { navigate } from '../../lib/router'
import type { ModuleConfig } from './moduleConfigs'
import { useModule } from './useModule'
import '../desktop/module.css'
import '../actual-utilities.css'

export function ModuleMobile({ config, apiStatus }: { config: ModuleConfig; apiStatus: ApiStatus }) {
  const { query, setQuery, statusFilter, setStatusFilter, formOpen, setFormOpen, title, setTitle, actionMessage, contentStatus, loadBlocked, load, itemStatus, statuses, filtering, visibleItems, create, itemLabel, itemMeta, ModuleIcon } = useModule(config, apiStatus)
  if (config.path === '/developer' || config.path === '/automation') {
    const developer = config.path === '/developer'
    return <div className="actual-utilities actual-utility-module">
      <header className="actual-utilities-bar"><div><p>{developer ? 'Local agent session metadata' : 'Policy-checked rules'}</p></div><div className="actual-utilities-bar__actions"></div></header>
      <div className="actual-utility-intro"><ModuleIcon size={20} aria-hidden="true" /><p>{developer ? 'Full session transcripts stay on your Mac. Access and execution depend on the approved project sandbox.' : 'Rules run only when allowed by the Policy Engine. Rule creation is not available here.'}</p></div>
      <div className="actual-utility-filter"><label className="mod-field"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${config.label.toLowerCase()}…`} aria-label={`Search ${config.label}`} /></label>{statuses.length > 1 && <SegmentedTabs tabs={['All', ...statuses].map((status) => ({ id: status, label: status }))} value={statusFilter} onChange={setStatusFilter} label="Filter by status" />}</div>
      {contentStatus === 'ready' && visibleItems.length > 0 ? <div className="mod-card actual-utility-list">{visibleItems.map((item) => <article className="mod-row" key={String(item.id)}><span className="mod-row__icon"><ModuleIcon size={17} aria-hidden="true" /></span><span className="mod-row__body"><strong className="mod-row__title">{developer ? String(item.adapter ?? 'Agent session') : String(item.name ?? 'Automation')}</strong><small className="mod-row__meta">{developer ? [item.state, item.last_activity_at].filter(Boolean).join(' · ') : [item.trigger_kind, item.policy_ref ? `Policy: ${String(item.policy_ref)}` : null].filter(Boolean).join(' · ')}</small></span>{itemStatus(item) && <span className="mod-row__badge">{itemStatus(item)}</span>}</article>)}</div> : contentStatus === 'empty' || (contentStatus === 'ready' && !visibleItems.length) ? <StateCard status="empty" title={filtering ? 'No matching records' : config.emptyTitle} description={filtering ? 'Try a different search or status.' : config.emptyDescription} /> : <StateCard status={contentStatus} title={contentStatus === 'loading' ? 'Loading' : loadBlocked ? 'Access restricted' : contentStatus === 'offline' ? 'You are offline' : 'Could not load'} description={contentStatus === 'loading' ? 'Loading records from the API.' : loadBlocked ? 'The request was denied. Check the owner session and applicable permissions.' : contentStatus === 'offline' ? 'Connect to load these records.' : 'Check the connection and try again.'} action={contentStatus === 'loading' ? undefined : <button type="button" className="mod-btn" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />Try again</button>} />}
    </div>
  }
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

        <button type="button" className="mod-link" onClick={() => navigate('/settings')}>Connection settings</button>
      </div>
      {formOpen && <form className="mod-create" onSubmit={create}><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Name your ${config.label.toLowerCase().replace(/s$/, '')}`} aria-label={`New ${config.label}`} /><button className="mod-btn mod-btn--primary" type="submit">Save</button><button className="mod-btn" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
      {actionMessage && <p className="mod-note" role="status">{actionMessage}</p>}
      {contentStatus === 'ready' && visibleItems.length > 0 ? <div className="mod-card">{visibleItems.map((item) => <article className="mod-row" key={String(item.id ?? `${itemLabel(item)}-${itemMeta(item)}`)}><span className="mod-row__icon"><ModuleIcon size={17} aria-hidden="true" /></span><span className="mod-row__body"><strong className="mod-row__title">{itemLabel(item)}</strong><small className="mod-row__meta">{itemMeta(item)}</small></span>{item.version ? <span className="mod-row__badge">v{String(item.version)}</span> : null}</article>)}</div> : contentStatus === 'empty' || (contentStatus === 'ready' && visibleItems.length === 0) ? <StateCard status="empty" title={filtering ? 'No matching records' : config.emptyTitle} description={filtering ? 'Try a different search term or status.' : config.emptyDescription} action={<button type="button" className="mod-link" onClick={() => navigate('/settings')}>Check API settings <ChevronRight size={14} /></button>} /> : <StateCard status={contentStatus} title={contentStatus === 'loading' ? 'Loading workspace' : contentStatus === 'offline' ? 'You are offline' : 'Could not load this app'} description={contentStatus === 'loading' ? 'Checking the configured API before loading this view.' : contentStatus === 'offline' ? 'Previously saved local settings remain available. Sync will resume when you are back online.' : 'The configured API did not respond. Check the base URL or try again.'} action={contentStatus === 'loading' ? undefined : <button type="button" className="mod-btn" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />Try again</button>} />}
    </div>
  </div>
}
