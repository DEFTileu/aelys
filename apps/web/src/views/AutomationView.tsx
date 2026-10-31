import { useCallback, useEffect, useState } from 'react'
import type { AutomationExecution, AutomationRule } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { ArrowRight, Check, Shield, Sparkles, X } from '../icons'
import { StateCard } from '../components/StateCard'
import { Switch } from '../components/Switch'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './connected.css'
import './tools.css'

type Outcome = 'success' | 'skipped' | 'blocked'
type Run = AutomationExecution & { ruleName: string }
const OUTCOME: Record<Outcome, { label: string; fg: string; bg: string }> = {
  success: { label: 'Succeeded', fg: '#14966c', bg: '#dcf5ec' },
  skipped: { label: 'Skipped', fg: '#625d69', bg: '#efe9e4' },
  blocked: { label: 'Blocked by policy', fg: '#c9302c', bg: '#fde8e7' },
}
// Only statuses the API actually reports are classified; anything else is shown as skipped-neutral text.
export const outcomeOf = (run: AutomationExecution): Outcome | null => {
  const status = run.run_status.toLowerCase()
  if (/policy|denied|blocked/.test(status) || /POLICY/.test(run.error_code ?? '')) return 'blocked'
  if (/skip/.test(status)) return 'skipped'
  if (/success|complete|done|ok/.test(status)) return 'success'
  return null
}
// Show only the kind of each action, never its payload.
const actionLabel = (rule: AutomationRule) => {
  const first = rule.actions?.[0]
  const kind = first && [first.type, first.kind, first.action].find((value) => typeof value === 'string')
  const base = typeof kind === 'string' ? kind : rule.actions?.length ? 'Action' : 'No action'
  return rule.actions && rule.actions.length > 1 ? `${base} +${rule.actions.length - 1}` : base
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function AutomationView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [rules, setRules] = useState<readonly AutomationRule[]>([])
  const [runs, setRuns] = useState<readonly Run[]>([])
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [blocked, setBlocked] = useState(false)
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const loaded = await client.automations()
      const results = await Promise.allSettled(loaded.map((rule) => client.automationExecutions(rule.id)))
      setRules(loaded)
      setRuns(results.flatMap((result, index) => result.status === 'fulfilled' ? result.value.map((run) => ({ ...run, ruleName: loaded[index].name })) : []).sort((a, b) => b.started_at.localeCompare(a.started_at)))
      setBlocked(false); setStatus('ready')
    } catch (error) {
      setBlocked(error instanceof ApiError && (error.status === 403 || /POLICY|FORBIDDEN|PERMISSION/.test(error.code)))
      setStatus(navigator.onLine ? 'error' : 'offline')
    }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])

  const toggle = async (rule: AutomationRule, enabled: boolean) => {
    setPending(rule.id); setNotice('')
    try { await getSharedApiClient().updateAutomation(rule.id, { enabled }, { queueOnOffline: false }); await load() }
    catch (error) { setNotice(error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : 'Could not update this rule.') }
    finally { setPending('') }
  }
  const lastRun = (rule: AutomationRule) => runs.find((run) => run.rule_id === rule.id)

  return <div className="tl connected-workspace">
    {/* Rule creation (describe, then review, then save) is not available in the API yet, so the input stays disabled. */}
    <div className="tl-ai" title="Coming soon"><Sparkles size={18} aria-hidden="true" />
      <input disabled aria-label="Describe a rule" title="Coming soon" placeholder="Describe a rule" />
      <button type="button" disabled aria-label="Create rule" title="Coming soon"><ArrowRight size={16} aria-hidden="true" /></button></div>
    {notice && <p className="tl-note" role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading automations' : blocked ? 'Access restricted' : status === 'offline' ? 'You are offline' : 'Could not load automations'}
      description={status === 'loading' ? 'Loading rules from the API.' : blocked ? 'The request was denied. Check the owner session and applicable permissions.' : 'Check the connection and try again.'} /> : <div className="tl-split" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
      <div className="tl-stack" style={{ gap: 12 }}>
        {rules.length ? rules.map((rule) => { const last = lastRun(rule); return <article key={rule.id} className={`tl-card tl-rule${rule.enabled === false ? ' tl-rule--off' : ''}`}>
          <div className="tl-row"><span className="tl-rule__name">{rule.name}</span><span className="tl-muted">{last ? `Last run ${when(last.started_at)}` : 'Never run'}</span>
            <Switch label={`${rule.name} enabled`} checked={rule.enabled !== false} pending={pending === rule.id} disabled={apiStatus !== 'ready'} onCheckedChange={(next) => void toggle(rule, next)} /></div>
          <div className="tl-sentence"><b>When</b><span className="tl-chip tl-chip--when">{rule.trigger_kind}</span><ArrowRight size={14} aria-hidden="true" /><b>Then</b><span className="tl-chip tl-chip--then">{actionLabel(rule)}</span>
            <span className="tl-chip tl-chip--policy"><Shield size={12} aria-hidden="true" />{rule.policy_ref}</span></div>
        </article> }) : <StateCard status="empty" title="No automations configured" description="Rules appear here once they exist. Aelys does not invent them." />}
      </div>
      <section className="tl-card" aria-label="Recent runs"><h2>Recent runs</h2>
        {runs.length ? runs.slice(0, 8).map((run) => { const outcome = outcomeOf(run); const style = outcome ? OUTCOME[outcome] : { label: run.run_status, fg: '#625d69', bg: '#efe9e4' }
          return <div className="tl-run" key={run.id}><span className="tl-run__mark" style={{ background: style.bg, color: style.fg }}>{outcome === 'success' ? <Check size={12} aria-hidden="true" /> : outcome === 'blocked' ? <X size={12} aria-hidden="true" /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}><div className="tl-run__title">{run.ruleName}</div><div className="tl-muted">{style.label} · {when(run.started_at)}</div></div></div> }) : <p className="tl-note">No runs recorded yet.</p>}
      </section>
    </div>}
  </div>
}
