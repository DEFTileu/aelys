import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AutomationDraft, AutomationRule, AutomationRuleIn, AutomationRun, AutomationRunStatus } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { ArrowRight, Check, Shield, Sparkles, X } from '../icons'
import { StateCard } from '../components/StateCard'
import { Switch } from '../components/Switch'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './connected.css'
import './tools.css'

const OUTCOME: Record<AutomationRunStatus, { label: string; fg: string; bg: string }> = {
  success: { label: 'Succeeded', fg: '#14966c', bg: '#dcf5ec' },
  skipped: { label: 'Skipped', fg: '#625d69', bg: '#efe9e4' },
  blocked_by_policy: { label: 'Blocked by policy', fg: '#c9302c', bg: '#fde8e7' },
  failed: { label: 'Failed', fg: '#c9302c', bg: '#fde8e7' },
  running: { label: 'Running', fg: '#2f6fe4', bg: '#e4eefd' },
}
const SOURCE = { structured: 'Built from your structured rule.', ai: 'Drafted by AI from your description. Review before saving.', parser: 'Parsed from your description. Review before saving.' } as const
const errorText = (error: unknown, fallback: string) => error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : fallback
// Show only the kind of each action, never its payload.
const actionLabel = (rule: AutomationRuleIn) => {
  const first = rule.actions?.[0]
  const kind = first && [first.type, first.kind, first.action].find((value) => typeof value === 'string')
  const base = typeof kind === 'string' ? kind : rule.actions?.length ? 'Action' : 'No action'
  return rule.actions && rule.actions.length > 1 ? `${base} +${rule.actions.length - 1}` : base
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function AutomationView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [rules, setRules] = useState<readonly AutomationRule[]>([])
  const [runs, setRuns] = useState<readonly AutomationRun[]>([])
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [blocked, setBlocked] = useState(false)
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState<AutomationDraft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState('')

  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const [loaded, recent] = await Promise.all([client.automations(), client.automationRuns(30)])
      setRules(loaded)
      setRuns([...recent].sort((a, b) => b.started_at.localeCompare(a.started_at)))
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
  const submitDraft = async (event: FormEvent) => {
    event.preventDefault()
    const text = description.trim()
    if (!text || drafting) return
    setDrafting(true); setDraftError(''); setDraft(null)
    try { setDraft(await getSharedApiClient().draftAutomation({ description: text }, { queueOnOffline: false })) }
    catch (error) { setDraftError(errorText(error, 'Could not draft this rule.')) }
    finally { setDrafting(false) }
  }
  const cancelDraft = () => { setDraft(null); setDraftError('') }
  const saveDraft = async () => {
    if (!draft || drafting) return
    setDrafting(true); setDraftError('')
    try { await getSharedApiClient().createAutomation({ ...draft.rule, reviewed_draft: true }, { queueOnOffline: false }); setDraft(null); setDescription(''); await load() }
    catch (error) { setDraftError(errorText(error, 'Could not save this rule.')) }
    finally { setDrafting(false) }
  }
  const lastRun = (rule: AutomationRule) => runs.find((run) => run.rule_id === rule.id)

  return <div className="tl connected-workspace">
    <form className="tl-ai" onSubmit={(event) => void submitDraft(event)}><Sparkles size={18} aria-hidden="true" />
      <input aria-label="Describe a rule" placeholder="Describe a rule" value={description} maxLength={500} disabled={apiStatus !== 'ready' || drafting} onChange={(event) => setDescription(event.target.value)} />
      <button type="submit" aria-label="Draft rule" disabled={apiStatus !== 'ready' || drafting || !description.trim()}><ArrowRight size={16} aria-hidden="true" /></button></form>
    {draftError && <p className="tl-note" role="alert">{draftError}</p>}
    {draft && <section className="tl-card tl-rule" aria-label="Review rule">
      <div className="tl-row"><span className="tl-rule__name">Review: {draft.rule.name}</span></div>
      <div className="tl-sentence"><b>When</b><span className="tl-chip tl-chip--when">{draft.rule.trigger_kind}</span><ArrowRight size={14} aria-hidden="true" /><b>Then</b><span className="tl-chip tl-chip--then">{actionLabel(draft.rule)}</span>
        <span className="tl-chip tl-chip--policy"><Shield size={12} aria-hidden="true" />{draft.policy.policy_ref} · {draft.policy.allowed ? 'Allowed' : 'Not allowed'}</span></div>
      {draft.policy.issues.length > 0 && <ul className="tl-note" aria-label="Policy issues">{draft.policy.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      <p className="tl-note">{SOURCE[draft.source]}</p>
      <div className="tl-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="tl-icon-btn" style={{ width: 'auto', height: 36, borderRadius: 12, padding: '0 14px' }} disabled={drafting} onClick={cancelDraft}>Cancel</button>
        <button type="button" className="tl-primary" style={{ height: 36, minWidth: 0, borderRadius: 12, padding: '0 16px', fontSize: 14 }} disabled={drafting || !draft.policy.allowed || apiStatus !== 'ready'} onClick={() => void saveDraft()}>Save rule</button></div>
    </section>}
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
        {runs.length ? runs.slice(0, 8).map((run) => { const style = OUTCOME[run.status] ?? { label: run.status, fg: '#625d69', bg: '#efe9e4' }
          return <div className="tl-run" key={run.id}><span className="tl-run__mark" style={{ background: style.bg, color: style.fg }}>{run.status === 'success' ? <Check size={12} aria-hidden="true" /> : run.status === 'blocked_by_policy' || run.status === 'failed' ? <X size={12} aria-hidden="true" /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}><div className="tl-run__title">{run.rule_name}</div><div className="tl-muted">{style.label} · {when(run.started_at)}</div></div></div> }) : <p className="tl-note">No runs recorded yet.</p>}
      </section>
    </div>}
  </div>
}
