import { useState } from 'react'
import './launch-intro.css'

/** A visual introduction only; authentication is always controlled by AuthGate. */
export function LaunchIntro() {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return <div className="launch-intro" aria-hidden="true" onAnimationEnd={(event) => {
    if (event.target === event.currentTarget && event.animationName === 'launch-out') setVisible(false)
  }}>
    <div className="launch-intro__stars">{[[12,18,0],[22,72,300],[31,30,600],[44,12,150],[58,24,450],[66,80,750],[74,14,250],[83,40,550],[90,68,100],[8,52,650],[38,86,400],[52,64,800],[18,40,200],[79,88,500],[62,46,700],[95,22,350]].map(([x,y,delay], i) => <span key={i} style={{ left: `${x}%`, top: `${y}%`, width: i % 3 ? 3 : 4, height: i % 3 ? 3 : 4, animationDelay: `${delay}ms,1400ms` }} />)}</div>
    <div className="launch-intro__sunrise" />
    <div className="launch-intro__scenery" />
    <div className="launch-intro__light" /><div className="launch-intro__content">
      <div className="launch-intro__mark"><img src="/icons/aelys-launch-mark.svg" width="188" height="154" alt="" /></div>
      <span className="launch-intro__name">{[...'Aelys'].map((letter, index) => <span key={index} style={{ animationDelay: `${1750 + index * 70}ms` }}>{letter}</span>)}</span>
      <span className="launch-intro__welcome">Welcome back</span>
    </div>
  </div>
}
