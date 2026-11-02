import { useEffect, useState, type CSSProperties } from 'react'
import { RotateCcw } from '../icons'
import { LucideGlyph } from './LucideGlyph'
import '../views/desktop/page-tokens.css'
import './page-skeleton.css'

export type SkeletonKind = 'home' | 'list' | 'split' | 'grid' | 'calendar' | 'chat' | 'settings'
export type SkeletonPhase = 'loading' | 'slow' | 'error'
const SHOW_AFTER_MS = 200, SLOW_AFTER_MS = 2500 // design: no flash for fast loads; slow notice after 2.5s

type Row = { hasAv: boolean; av: string; avR: string; w1: string; two: boolean; w2: string; tail: boolean; tw: string; th: string; tr: string; mh: string }
type Line = { w: string; h: string; r: string; ml: string }
type Card = { col: string; h: string; head: boolean; hw: string; rows: Row[]; lines: Line[] }
const W = ['72%', '58%', '84%', '46%', '66%', '78%', '52%', '62%']
const rows = (n: number, o: Partial<Row> = {}): Row[] => Array.from({ length: n }, (_, i) => ({ hasAv: true, av: '20px', avR: '50%', w1: W[i % 8], two: false, w2: W[(i + 3) % 8], tail: false, tw: '44px', th: '10px', tr: '5px', mh: '28px', ...o }))
const lines = (arr: (string | Partial<Line>)[]): Line[] => arr.map((x) => typeof x === 'string' ? { w: x, h: '12px', r: '6px', ml: '0' } : { w: '100%', h: '12px', r: '6px', ml: '0', ...x })
const card = (o: Partial<Card>): Card => ({ col: 'auto', h: '0', head: false, hw: '40%', rows: [], lines: [], ...o })

// Layout per kind, copied from the design's AelysSkeleton (same sizes, counts and widths).
export function skeletonLayout(kind: SkeletonKind, compact: boolean): { cols: string; cards: Card[] } {
  const para = lines([{ w: '46%', h: '22px', r: '8px' }, '100%', '96%', '88%', '64%', { w: '0', h: '6px' }, '100%', '92%', '70%'])
  switch (kind) {
    case 'home': return { cols: compact ? 'repeat(2,minmax(0,1fr))' : 'repeat(auto-fill,minmax(240px,1fr))', cards: (compact ? [2, 1, 1, 2] : [2, 1, 1, 2, 1, 1]).map((s, i) => card({ col: `span ${s}`, h: compact ? '150px' : '220px', head: true, hw: ['34%', '50%', '46%', '30%', '52%', '44%'][i], lines: lines(s === 2 ? ['80%', '64%', '72%'] : [{ w: '54%', h: '30px', r: '8px' }, '70%']) })) }
    case 'split': return { cols: compact ? 'minmax(0,1fr)' : '320px minmax(0,1fr)', cards: [card({ rows: rows(compact ? 6 : 8, { av: '36px', two: true, mh: '44px' }) }), ...(compact ? [] : [card({ h: '520px', lines: para })])] }
    case 'grid': return { cols: compact ? 'minmax(0,1fr)' : 'repeat(auto-fill,minmax(260px,1fr))', cards: Array.from({ length: compact ? 3 : 6 }, (_, i) => card({ h: compact ? '120px' : '170px', head: true, hw: W[i], lines: lines([W[(i + 2) % 8], { w: '100%', h: '6px', r: '3px' }, '40%']) })) }
    case 'calendar': return { cols: compact ? 'minmax(0,1fr)' : 'minmax(0,1fr) 300px', cards: [card({ head: true, hw: '24%', lines: lines([{ w: '100%', h: compact ? '300px' : '460px', r: '14px' }]) }), ...(compact ? [] : [card({ head: true, hw: '50%', rows: rows(5, { av: '4px', avR: '2px', two: true, mh: '40px' }) })])] }
    case 'chat': return { cols: 'minmax(0,1fr)', cards: [card({ h: compact ? '420px' : '520px', lines: lines([{ w: '46%', h: '40px', r: '16px' }, { w: '58%', h: '64px', r: '16px', ml: 'auto' }, { w: '38%', h: '40px', r: '16px' }, { w: '64%', h: '88px', r: '16px' }, { w: '30%', h: '40px', r: '16px', ml: 'auto' }]) })] }
    case 'settings': return { cols: compact ? 'minmax(0,1fr)' : '260px minmax(0,1fr)', cards: [card({ rows: rows(compact ? 6 : 9, { av: '30px', avR: '9px', mh: compact ? '44px' : '36px', two: compact }) }), ...(compact ? [] : [card({ head: true, hw: '30%', rows: rows(5, { hasAv: false, two: true, tail: true, tw: '44px', th: '26px', tr: '13px', mh: '48px' }) })])] }
    default: return { cols: 'minmax(0,1fr)', cards: [card({ rows: rows(compact ? 7 : 9, { tail: !compact, mh: compact ? '40px' : '32px', two: compact }) })] }
  }
}

const Bone = ({ style, fixed }: { style: CSSProperties; fixed?: boolean }) => <span className="pskel__bone" data-sk="" style={fixed ? { ...style, flex: 'none' } : style} />

export function PageSkeleton({ kind = 'list', phase = 'loading', compact = false, label = 'page', onRetry }: { kind?: SkeletonKind; phase?: SkeletonPhase; compact?: boolean; label?: string; onRetry?: () => void }) {
  const [waited, setWaited] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    setWaited(false); setShown(false)
    if (phase !== 'loading') return
    const show = window.setTimeout(() => setShown(true), SHOW_AFTER_MS)
    const timer = window.setTimeout(() => setWaited(true), SLOW_AFTER_MS)
    return () => { window.clearTimeout(show); window.clearTimeout(timer) }
  }, [phase])
  const error = phase === 'error', slow = phase === 'slow' || (phase === 'loading' && waited)
  const { cols, cards } = skeletonLayout(kind, compact)
  const hidden = phase === 'loading' && !shown
  return <div className="pskel" role="status" aria-live="polite" aria-busy={!error}>
    <span className="pskel__sr">{error ? `Could not load ${label}` : `Loading ${label}…`}</span>
    {hidden ? null : <>
    {!error && <div className="pskel__bar" aria-hidden="true"><span data-bar="" /></div>}
    {slow && <div className="pskel__slow">
      <span className="pskel__spin" data-spin="" />
      <div className="pskel__slow-text"><div>Taking longer than usual</div><div>Your Aelys server is waking up. This can take up to 30 seconds.</div></div>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>}
    {error && <div className="pskel__error" style={{ minHeight: compact ? 360 : 440 }}>
      <span className="pskel__error-icon"><LucideGlyph name="wifi-off" size={26} /></span>
      <div className="pskel__error-title">Can’t reach Aelys</div>
      <div className="pskel__error-text">Check your connection. Anything you change is saved on this device and syncs when you’re back online.</div>
      <div className="pskel__error-actions"><button type="button" onClick={onRetry}><RotateCcw size={14} />Try again</button></div>
    </div>}
    {!error && <div className="pskel__grid" aria-hidden="true" style={{ gridTemplateColumns: cols, gap: compact ? 12 : 16 }}>
      {cards.map((c, i) => <div key={i} className="pskel__card" style={{ gridColumn: c.col, minHeight: c.h, padding: compact ? 14 : 18 }}>
        {c.head && <div className="pskel__row pskel__head"><Bone fixed style={{ width: 28, height: 28, borderRadius: 8 }} /><Bone style={{ width: c.hw, height: 14, borderRadius: 7 }} /></div>}
        {c.rows.map((r, j) => <div key={j} className="pskel__row" style={{ minHeight: r.mh }}>
          {r.hasAv && <Bone fixed style={{ width: r.av, height: r.av, borderRadius: r.avR }} />}
          <div className="pskel__lines"><Bone style={{ width: r.w1, height: 12, borderRadius: 6 }} />{r.two && <Bone style={{ width: r.w2, height: 10, borderRadius: 5 }} />}</div>
          {r.tail && <Bone fixed style={{ width: r.tw, height: r.th, borderRadius: r.tr }} />}
        </div>)}
        {c.lines.map((l, j) => <Bone key={j} style={{ width: l.w, height: l.h, marginLeft: l.ml, borderRadius: l.r }} />)}
      </div>)}
    </div>}
    </>}
  </div>
}
