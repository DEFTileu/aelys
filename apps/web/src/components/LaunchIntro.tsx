import { useEffect, useState, type ReactNode } from 'react'
import './launch-intro.css'

const STARS = [[12, 18, 0], [22, 72, 300], [31, 30, 600], [44, 12, 150], [58, 24, 450], [66, 80, 750], [74, 14, 250], [83, 40, 550], [90, 68, 100], [8, 52, 650], [38, 86, 400], [52, 64, 800], [18, 40, 200], [79, 88, 500], [62, 46, 700], [95, 22, 350]]
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * One continuous launch scene (ACTUAL launch design, variant C). The introduction plays, then the hero
 * shrinks in place and the entry card grows out below it; there is no screen swap. A signed-in session
 * fades the scene out instead. Authentication itself is always controlled by AuthGate.
 */
export function LaunchIntro({ resolved, locked, children, footer }: { resolved: boolean; locked: boolean; children?: ReactNode; footer?: ReactNode }) {
  const [introElapsed, setIntroElapsed] = useState(false)
  const [settled, setSettled] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setIntroElapsed(true), reducedMotion() ? 300 : 2700)
    return () => window.clearTimeout(timer)
  }, [])
  const phase = !introElapsed || !resolved ? 'intro' : locked ? 'lock' : 'out'
  const lock = phase === 'lock'
  // A later sign-out or expired session brings the entry card back without replaying the introduction.
  useEffect(() => { if (locked) setDismissed(false) }, [locked])
  // Lets focus rings and notices escape the card once its reveal has finished.
  useEffect(() => {
    if (!lock) { setSettled(false); return }
    const timer = window.setTimeout(() => setSettled(true), reducedMotion() ? 0 : 1150)
    return () => window.clearTimeout(timer)
  }, [lock])
  if (dismissed && !locked) return null
  return <div className={`launch-intro launch-intro--${phase}`} onAnimationEnd={(event) => {
    if (event.target === event.currentTarget && event.animationName === 'launch-leave') setDismissed(true)
  }}>
    <div className="launch-intro__backdrop" aria-hidden="true">
      <div className="launch-intro__stars">{STARS.map(([x, y, delay], i) => <span key={i} style={{ left: `${x}%`, top: `${y}%`, width: i % 3 ? 3 : 4, height: i % 3 ? 3 : 4, animationDelay: `${delay}ms,1400ms` }} />)}</div>
      <div className="launch-intro__sunrise" />
      <div className="launch-intro__scenery" />
      <div className="launch-intro__light" />
      <div className="launch-intro__dim" />
    </div>
    <div className="launch-stage">
      <div className="launch-stage__hero" aria-hidden="true">
        <div className="launch-intro__mark"><img src="/icons/aelys-launch-mark.svg" alt="" /></div>
        <span className="launch-intro__name">{[...'Aelys'].map((letter, index) => <span key={index} style={{ animationDelay: `${1750 + index * 70}ms` }}>{letter}</span>)}</span>
        <span className="launch-intro__welcome">Welcome back</span>
      </div>
      <div className="launch-stage__card">
        <div className="launch-stage__card-inner" data-settled={settled || undefined} inert={!lock || undefined}>{children}</div>
      </div>
    </div>
    {footer && <div className="launch-stage__foot" inert={!lock || undefined}>{footer}</div>}
  </div>
}
