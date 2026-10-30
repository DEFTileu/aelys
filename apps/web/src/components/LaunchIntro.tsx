import { useState } from 'react'
import { AelysMark } from './AelysMark'
import './launch-intro.css'

/** A visual introduction only; authentication is always controlled by AuthGate. */
export function LaunchIntro() {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return <div className="launch-intro" aria-hidden="true" onAnimationEnd={(event) => {
    if (event.target === event.currentTarget && event.animationName === 'launch-out') setVisible(false)
  }}>
    <div className="launch-intro__sunrise" />
    <div className="launch-intro__scenery" />
    <div className="launch-intro__content">
      <div className="launch-intro__mark"><AelysMark size={188} /><span className="launch-intro__star">✦</span></div>
      <span className="launch-intro__name">Aelys</span>
      <span className="launch-intro__welcome">С возвращением</span>
    </div>
  </div>
}
