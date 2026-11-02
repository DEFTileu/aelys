import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CircleHelp } from 'lucide-react'
import type { AutomationDraft, AutomationRule, AutomationRuleIn, AutomationRun, AutomationRunStatus } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { ArrowRight, Bell, Check, NotebookText, Shield, Sparkles, SquareCheck, Workflow, X, Zap, type AelysIconComponent } from '../icons'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import './connected.css'
import './tools.css'
import './automation.css'
import './automation/automation-mobile.css'

const OUTCOME: Record<AutomationRunStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  success: { label: 'Succeeded', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'warn' },
  blocked_by_policy: { label: 'Blocked by policy', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  running: { label: 'Running', tone: 'info' },
}
const SOURCE = { structured: 'Built from your structured rule.', ai: 'Drafted by AI from your description. Review before saving.', parser: 'Parsed from your description. Review before saving.' } as const
// Only the trigger and action kinds the backend engine supports; anything else shows its raw kind.
const TRIGGERS: Record<string, { label: string; Icon: AelysIconComponent }> = {
  'task.created': { label: 'Task created', Icon: SquareCheck }, 'task.completed': { label: 'Task completed', Icon: SquareCheck }, 'note.created': { label: 'Note created', Icon: NotebookText },
}
const ACTIONS: Record<string, { label: string; Icon: AelysIconComponent }> = { create_task: { label: 'Create task', Icon: SquareCheck }, create_notification: { label: 'Send notification', Icon: Bell } }
const TEMPLATES: readonly { name: string; summary: string; rule: AutomationRuleIn }[] = [
  { name: 'Celebrate finished tasks', summary: 'Task completed → notification', rule: { name: 'Celebrate finished tasks', trigger_kind: 'task.completed', conditions: {}, actions: [{ kind: 'create_notification', args: { title: 'Task done', body: 'Nice work.' } }], policy_ref: 'safe', rate_limit: {} } },
  { name: 'Follow up on notes', summary: 'Note created → task to review it', rule: { name: 'Follow up on notes', trigger_kind: 'note.created', conditions: {}, actions: [{ kind: 'create_task', args: { title: 'Review new note' } }], policy_ref: 'safe', rate_limit: {} } },
]
const STEPS = [['When', 'Pick what starts it: a task or a note being created or completed.'], ['Then', 'Pick one action. Aelys only does what the policy allows.'], ['Review', 'See the rule as a sentence before it goes live. Pause it any time.']] as const
const errorText = (error: unknown, fallback: string) => error instanceof ApiError || error instanceof OfflineWriteUnavailableError ? `${error.code}: ${error.message}` : fallback
// Show only the kind of each action, never its payload.
const actionKind = (rule: AutomationRuleIn) => {
  const first = rule.actions?.[0]
  const kind = first && [first.type, first.kind, first.action].find((value) => typeof value === 'string')
  return typeof kind === 'string' ? kind : null
}
const actionChip = (rule: AutomationRuleIn) => {
  const kind = actionKind(rule)
  const known = kind ? ACTIONS[kind] : undefined
  const base = known?.label ?? kind ?? (rule.actions?.length ? 'Action' : 'No action')
  return { label: rule.actions && rule.actions.length > 1 ? `${base} +${rule.actions.length - 1}` : base, Icon: known?.Icon ?? Zap }
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function Sentence({ rule, policy }: { rule: AutomationRuleIn; policy?: string }) {
  const trigger = TRIGGERS[rule.trigger_kind]; const TriggerIcon = trigger?.Icon ?? Zap; const action = actionChip(rule)
  return <div className="au-sentence"><b>When</b><span className="au-chip au-chip--when"><TriggerIcon size={14} aria-hidden="true" />{trigger?.label ?? rule.trigger_kind}</span><ArrowRight size={14} className="au-arrow" aria-hidden="true" />
    <b>Then</b><span className="au-chip au-chip--then"><action.Icon size={14} aria-hidden="true" />{action.label}</span>
    {policy && <span className="au-chip au-chip--policy"><Shield size={12} aria-hidden="true" />{policy}</span>}</div>
}

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
  const [guide, setGuide] = useState(false)

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
    catch (error) { setNotice(errorText(error, 'Could not update this rule.')) }
    finally { setPending('') }
  }
  const requestDraft = async (body: { description: string } | { rule: AutomationRuleIn }) => {
    if (drafting) return
    setDrafting(true); setDraftError(''); setDraft(null)
    try { setDraft(await getSharedApiClient().draftAutomation(body, { queueOnOffline: false })) }
    catch (error) { setDraftError(errorText(error, 'Could not draft this rule.')) }
    finally { setDrafting(false) }
  }
  const submitDraft = (event: FormEvent) => {
    event.preventDefault()
    const text = description.trim()
    if (text) void requestDraft({ description: text })
  }
  const cancelDraft = () => { setDraft(null); setDraftError('') }
  const saveDraft = async () => {
    if (!draft || drafting) return
    setDrafting(true); setDraftError('')
    try { await getSharedApiClient().createAutomation({ ...draft.rule, reviewed_draft: true }, { queueOnOffline: false }); setDraft(null); setDescription(''); setGuide(false); await load() }
    catch (error) { setDraftError(errorText(error, 'Could not save this rule.')) }
    finally { setDrafting(false) }
  }
  const lastRun = (rule: AutomationRule) => runs.find((run) => run.rule_id === rule.id)
  const ready = apiStatus === 'ready'
  const inUse = status === 'ready' && rules.length > 0
  const showGuide = status === 'ready' && (!inUse || guide)
  const mobile = useIsMobile()

  return <div className={`au${mobile ? ' au-m' : ''}`}>
    <div className="au-top">
      <form className="au-ask" onSubmit={submitDraft}><Sparkles size={18} aria-hidden="true" />
        <input aria-label="Describe a rule" placeholder={window.matchMedia?.('(max-width: 700px)').matches ? 'Describe a rule…' : 'Describe a rule: "When a task is completed, send me a notification"'} value={description} maxLength={500} disabled={!ready || drafting} onChange={(event) => setDescription(event.target.value)} />
        <button type="submit" aria-label="Draft rule" disabled={!ready || drafting}><ArrowRight size={14} aria-hidden="true" /></button></form>
      {inUse && <button type="button" className="au-guide-btn" onClick={() => setGuide(!guide)}><CircleHelp size={14} aria-hidden="true" />{guide ? 'Hide guide' : 'How it works'}</button>}
    </div>
    {draftError && <p className="au-note" role="alert">{draftError}</p>}
    {draft && <section className="au-review" aria-label="Review rule">
      <div className="au-review__tag"><Sparkles size={14} aria-hidden="true" />Review before saving</div>
      <div className="au-review__name">{draft.rule.name}</div>
      <Sentence rule={draft.rule} />
      <div className="au-note"><span className="au-policy"><Shield size={12} aria-hidden="true" />Policy: {draft.policy.policy_ref} · {draft.policy.allowed ? 'Allowed' : 'Not allowed'}</span> {SOURCE[draft.source]}</div>
      {draft.policy.issues.length > 0 && <ul className="au-note" aria-label="Policy issues">{draft.policy.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      <div className="au-review__actions">
        <button type="button" className="au-save" disabled={drafting || !draft.policy.allowed || !ready} onClick={() => void saveDraft()}>Save rule</button>
        <button type="button" className="au-cancel" disabled={drafting} onClick={cancelDraft}>Cancel</button></div>
    </section>}
    {notice && <p className="au-note" role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading automations' : blocked ? 'Access restricted' : status === 'offline' ? 'You are offline' : 'Could not load automations'}
      description={status === 'loading' ? 'Loading rules from the API.' : blocked ? 'The request was denied. Check the owner session and applicable permissions.' : 'Check the connection and try again.'} /> : <>
      {showGuide && <section className="au-guide" aria-label="How it works">
        <div className="au-guide__head"><span className="au-guide__icon"><Workflow size={22} aria-hidden="true" /></span><div><h2>Let Aelys handle the routine</h2><p>A rule watches for something and then does one thing for you. Nothing runs until you've reviewed it.</p></div></div>
        <div className="au-steps">{STEPS.map(([title, text], index) => <div className="au-step" key={title}><div><span>{index + 1}</span><strong>{title}</strong></div><p>{text}</p></div>)}</div>
        <div className="au-templates"><h3>Start from a template</h3>
          <div className="au-templates__grid">{TEMPLATES.map((template) => { const added = rules.some((rule) => rule.name === template.name)
            return <div className="au-template" key={template.name}><div><strong>{template.name}</strong><small>{template.summary}</small></div>
              <button type="button" disabled={!ready || drafting || added} onClick={() => void requestDraft({ rule: template.rule })}>{added ? 'Added' : 'Use'}</button></div> })}</div></div>
      </section>}
      {inUse && <div className="au-main">
        <div className="au-rules">{rules.map((rule) => { const last = lastRun(rule); const on = rule.enabled !== false
          return <article key={rule.id} className={`au-rule${on ? '' : ' au-rule--off'}`}>
            <div className="au-rule__head"><span className="au-rule__name">{rule.name}</span><span className="au-rule__last">{on ? last ? `Last run ${when(last.started_at)}` : 'Never run' : 'Paused'}</span>
              <button type="button" role="switch" aria-checked={on} aria-label={`${rule.name} enabled`} className="au-switch" disabled={!ready || pending === rule.id} onClick={() => void toggle(rule, !on)}><span /></button></div>
            <Sentence rule={rule} policy={rule.policy_ref} />
          </article> })}</div>
        <section className="au-runs" aria-label="Recent runs"><h2>Recent runs</h2>
          {runs.length ? runs.slice(0, 8).map((run) => { const outcome = OUTCOME[run.status] ?? { label: run.status, tone: 'warn' as const }
            return <div className="au-run" key={run.id}><span className={`au-run__mark au-run__mark--${outcome.tone}`}>{run.status === 'success' ? <Check size={12} aria-hidden="true" /> : run.status === 'blocked_by_policy' || run.status === 'failed' ? <X size={12} aria-hidden="true" /> : run.status === 'skipped' ? <ArrowRight size={12} aria-hidden="true" /> : <i />}</span>
              <div><div className="au-run__title">{run.rule_name}</div><div className="au-run__sub">{outcome.label} · {when(run.started_at)}</div></div></div> }) : <p className="au-note">No runs recorded yet.</p>}
        </section>
      </div>}
    </>}
  </div>
}
