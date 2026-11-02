import { useState, type CSSProperties } from 'react'
import './crossfade-photo.css'

/** Keeps the previous photo underneath while the new one fades in over 600ms (instant under reduce-motion). */
export function CrossfadePhoto({ url, height }: { url: string; height: number }) {
  const [cur, setCur] = useState(url)
  const [prev, setPrev] = useState<string | null>(null)
  if (url !== cur) { setPrev(cur); setCur(url) }
  const style = (image: string): CSSProperties => ({ height, backgroundImage: `url('${image}')` })
  return <>
    {prev && <div className="shell-photo" aria-hidden="true" style={style(prev)} />}
    <div key={cur} className={`shell-photo${prev ? ' shell-photo-fade' : ''}`} aria-hidden="true" style={style(cur)} onAnimationEnd={() => setPrev(null)} />
  </>
}
