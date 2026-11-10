import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AIAction, AIFeedback } from '@aelys/shared'
import { Calendar, Check, ChevronDown, ChevronRight, Copy, FileText, RotateCcw, Sparkles, ThumbsDown, ThumbsUp, X } from '../../icons'
import { SOURCES, formatBytes, stepsSummary, type RunStep, type SourceId, type Tone } from './chatModel'

const tile = (tone: Pick<Tone, 'color' | 'soft'>) => ({ '--tc': tone.color, '--ts': tone.soft }) as CSSProperties

export function Tile({ tone, size }: { tone: Pick<Tone, 'color' | 'soft'> & { Icon: Tone['Icon'] }; size: number }) {
  return <span className="actual-ai__tile" style={tile(tone)} aria-hidden="true"><tone.Icon size={size} /></span>
}

/** "What Aelys can see": one row per readable source with a real switch. */
export function SourceRows({ on, onToggle, busy, large }: { on: ReadonlySet<SourceId>; onToggle: (id: SourceId, next: boolean) => void; busy?: boolean; large?: boolean }) {
  return <div className={`actual-ai__sources${large ? ' actual-ai__sources--large' : ''}`}>{SOURCES.map((source) => {
    const checked = on.has(source.id)
    return <div className="actual-ai__source" key={source.id}>
      <Tile tone={{ Icon: source.Icon, color: source.color, soft: source.soft }} size={large ? 15 : 14} />
      <div><b>{source.name}</b><span>{checked ? source.on : source.off}</span></div>
      <button type="button" role="switch" aria-checked={checked} aria-label={source.name} disabled={busy} className="actual-ai__switch" onClick={() => onToggle(source.id, !checked)}><i /></button>
    </div>
  })}</div>
}

/** Composer chip target: popover on desktop, bottom sheet on a phone (same markup, CSS decides). */
export function SourcesPopover({ on, onToggle, onClose, busy }: { on: ReadonlySet<SourceId>; onToggle: (id: SourceId, next: boolean) => void; onClose: () => void; busy?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!root.current?.parentElement?.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [onClose])
  return <div className="actual-ai__popover" role="dialog" aria-label="What Aelys can see" ref={root}>
    <div className="actual-ai__popover-head"><b>What Aelys can see</b><button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
    <p>In this chat only</p>
    <SourceRows on={on} onToggle={onToggle} busy={busy} large />
  </div>
}

/** Collapsed "Read your tasks · Read calendar" chip; open while the run is live. */
export function RunSteps({ steps, live }: { steps: readonly RunStep[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  const summary = stepsSummary(steps)
  if (!live && !open) return <button type="button" className="actual-ai__steps-chip" aria-expanded="false" onClick={() => setOpen(true)}><Check size={14} />{summary}<ChevronRight size={13} /></button>
  return <div className="actual-ai__steps" aria-live="polite">
    {!live && <button type="button" className="actual-ai__steps-head" aria-expanded="true" onClick={() => setOpen(false)}>{summary}<ChevronDown size={13} /></button>}
    {steps.map((step) => {
      // Every row keeps an icon slot, so steps without a source (create task, memory…) stay aligned.
      const StepIcon = SOURCES.find((item) => item.id === step.source)?.Icon ?? Sparkles
      return <div key={step.id} className="actual-ai__step">
        {step.state === 'run' ? <span className="actual-ai__spinner" role="status" aria-label="Running" /> : <Check size={14} className="actual-ai__step-done" />}
        <StepIcon size={14} className="actual-ai__step-icon" />
        <b>{step.label}</b>{step.detail && <span>{step.detail}</span>}
      </div>
    })}
  </div>
}

const BAR = ['#2F6FE4', '#D93636', '#6A4CF2', '#14966C', '#F06A58']
/** A change Aelys proposes. Nothing is applied until Approve. */
export function ActionCard({ action, busy, onApprove, onReject, onAdjust }: { action: AIAction; busy: boolean; onApprove: () => void; onReject: () => void; onAdjust: () => void }) {
  const pending = action.status === 'pending'
  const result = typeof action.result === 'string' ? action.result : action.result && typeof action.result === 'object' && 'message' in action.result ? String((action.result as { message: unknown }).message) : ''
  return <section className="actual-ai__action" aria-label={action.title}>
    <header><Calendar size={18} /><div><b>{action.title}</b>{action.summary && <span>{action.summary}</span>}</div></header>
    {action.items.map((item, index) => <div className="actual-ai__action-item" key={`${index}-${item.title}`}>
      <i style={{ background: BAR[index % BAR.length] }} />{item.meta && <time>{item.meta}</time>}
      <div><b>{item.title}</b>{item.detail && <span>{item.detail}</span>}</div>
    </div>)}
    <footer>
      {pending ? <>
        <button type="button" className="actual-ai__action-primary" disabled={busy} onClick={onApprove}><Check size={16} />Approve</button>
        <button type="button" className="actual-ai__action-secondary" disabled={busy} onClick={onAdjust}>Adjust</button>
        <button type="button" className="actual-ai__action-secondary" disabled={busy} onClick={onReject}>Reject</button>
      </> : <span className={`actual-ai__action-status actual-ai__action-status--${action.status}`}>{action.status === 'approved' ? <><Check size={16} />Approved</> : action.status === 'rejected' ? <><X size={16} />Rejected</> : 'Failed'}{action.status === 'failed' && result ? ` · ${result}` : ''}</span>}
    </footer>
  </section>
}

export function FileChip({ name, size, onRemove, pending }: { name: string; size?: number; onRemove?: () => void; pending?: boolean }) {
  return <span className="actual-ai__file"><FileText size={16} /><b>{name}</b>{pending ? <span>Uploading…</span> : size !== undefined && <span>{formatBytes(size)}</span>}
    {onRemove && <button type="button" aria-label={`Remove ${name}`} onClick={onRemove}><X size={13} /></button>}</span>
}

/** Copy, regenerate, thumbs and the run meta under a finished answer. */
export function AnswerActions({ text, meta, feedback, canRegenerate, regenDisabled, canRate, onRegenerate, onFeedback }: { text: string; meta?: string; feedback: AIFeedback; canRegenerate: boolean; regenDisabled: boolean; canRate: boolean; onRegenerate: () => void; onFeedback: (next: AIFeedback) => void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer) }, [copied])
  const copy = () => { void Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => undefined); setCopied(true) }
  return <div className="actual-ai__tools">
    <button type="button" className="actual-ai__tool" aria-label="Copy" title="Copy" onClick={copy}>{copied ? <><Check size={15} />Copied</> : <Copy size={15} />}</button>
    {canRegenerate && <button type="button" className="actual-ai__tool" aria-label="Regenerate" title="Regenerate" disabled={regenDisabled} onClick={onRegenerate}><RotateCcw size={15} /></button>}
    <button type="button" className="actual-ai__tool" aria-label="Good answer" aria-pressed={feedback === 'up'} data-on={feedback === 'up' || undefined} disabled={!canRate} onClick={() => onFeedback(feedback === 'up' ? null : 'up')}><ThumbsUp size={15} /></button>
    <button type="button" className="actual-ai__tool actual-ai__tool--down" aria-label="Bad answer" aria-pressed={feedback === 'down'} data-on={feedback === 'down' || undefined} disabled={!canRate} onClick={() => onFeedback(feedback === 'down' ? null : 'down')}><ThumbsDown size={15} /></button>
    {meta && <span className="actual-ai__meta">{meta}</span>}
  </div>
}
