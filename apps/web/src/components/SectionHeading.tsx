import type { ReactNode } from 'react'
import { Icon } from './Icon'

export function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{action && <div className="section-heading__action">{action}<Icon name="chevron-right" size={16} /></div>}</div>
}
