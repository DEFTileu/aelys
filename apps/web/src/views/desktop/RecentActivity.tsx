import type { CSSProperties, ReactNode } from 'react'
import { Calendar, Check, ChevronRight, FileText, Mail, Zap } from '../../icons'
import { CloudUpload } from 'lucide-react'
import type { ActivityEvent } from '@aelys/shared'
import { ACCENT, accentOf, type AccentKey } from '../../data/desktop/home'
import { ageLabel } from '../../lib/format'

const tile = (key: AccentKey): CSSProperties => ({ background: `${ACCENT[key]}1A`, color: accentOf(key).ink })

function activityLook(kind: string): { title: string; icon: ReactNode; key: AccentKey } {
  const text = kind.replace(/[._]/g, ' ')
  const area = kind.split(/[._]/)[0]
  if (area === 'mail') return { title: 'New email', icon: <Mail size={16} aria-hidden="true" />, key: 'coral' }
  if (area === 'task') return { title: text.includes('complet') ? 'Task completed' : 'Task updated', icon: <Check size={16} aria-hidden="true" />, key: 'green' }
  if (area === 'note') return { title: 'Note updated', icon: <FileText size={16} aria-hidden="true" />, key: 'blue' }
  if (area === 'calendar' || area === 'event') return { title: 'Event updated', icon: <Calendar size={16} aria-hidden="true" />, key: 'red' }
  if (area === 'file' || area === 'upload') return { title: 'File uploaded', icon: <CloudUpload size={16} aria-hidden="true" />, key: 'violet' }
  return { title: text.charAt(0).toUpperCase() + text.slice(1), icon: <Zap size={16} aria-hidden="true" />, key: 'violet' }
}
const subtitleOf = (item: ActivityEvent) => { const meta = item.non_sensitive_metadata as Record<string, unknown>; const named = ['title', 'name', 'subject'].map((field) => meta?.[field]).find((value) => typeof value === 'string' && value) as string | undefined; return named ?? (item.actor_kind === 'user' ? 'You' : item.actor_kind) }


/** Fixed full-width section at the bottom of Home, as in the design: it is not a customizable widget. */
export function RecentActivity({ items, state }: { items: readonly ActivityEvent[]; state?: string }) {
  const { soft, ink } = accentOf('violet')
  return <section aria-label="Recent activity" className="home-widget home-activity-section" data-glass="">
    <div data-widget-heading="" className="dw-head">
      <span className="dw-head-icon" style={{ background: soft, color: ink }}><Zap size={16} /></span>
      <span className="dw-head-title">Recent activity</span>
      <span className="dw-head-meta" />
      <span className="dw-head-link">All events<ChevronRight size={16} /></span>
    </div>
    {state === 'loading' ? <div className="dw-empty"><span>Loading…</span></div>
      : state && state !== 'ready' ? <div className="dw-empty"><span>Can’t load</span></div>
      : !items.length ? <div className="dw-empty"><span>No recorded activity yet.</span></div>
      : <div className="dw-grid dw-act dw-act--section">{items.slice(0, 4).map((item) => {
        const look = activityLook(item.event_kind)
        return <div key={item.id} className="dw-act-item"><span className="dw-tile" style={tile(look.key)}>{look.icon}</span><div className="dw-act-main"><div className="dw-act-line"><span>{look.title}</span><span>{ageLabel(item.occurred_at)}</span></div><div className="dw-row-sub">{subtitleOf(item)}</div></div></div>
      })}</div>}
  </section>
}
