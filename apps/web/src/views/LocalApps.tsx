import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { calculate, CalcError } from '../lib/calc'
import { Plus, X } from '../icons'

/** Small client-only apps. Nothing here touches the API, storage (except Zones' city list) or AI. */

function randomInt(max: number): number {
  const buffer = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / max) * max
  do crypto.getRandomValues(buffer); while (buffer[0]! >= limit)
  return buffer[0]! % max
}

export function CalculatorApp() {
  const [text, setText] = useState('')
  const [history, setHistory] = useState<readonly { q: string; a: string }[]>([])
  const [error, setError] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    try { const a = calculate(text); setHistory([{ q: text.trim(), a }, ...history].slice(0, 8)); setError(''); setText(a.includes(' ') ? '' : a) }
    catch (e) { setError(e instanceof CalcError ? e.message : 'Could not calculate that') }
  }
  return <section className="app-panel" aria-label="Calculator">
    <form onSubmit={submit} className="app-row"><input className="app-field" aria-label="Expression" autoFocus value={text} onChange={e => { setText(e.target.value); setError('') }} placeholder="24 × 12, 15% of 80, 5 km to mi, 100 c to f" /><button type="submit" className="app-btn app-btn--primary">Calculate</button></form>
    {error && <p className="app-error" role="alert">{error}</p>}
    <div className="app-list" aria-label="History">{history.length ? history.map((item, index) => <button type="button" key={index} className="app-history" onClick={() => setText(item.q)}><span>{item.q}</span><strong>= {item.a}</strong></button>) : <p className="app-muted">Math, percent, units (km, mi, kg, lb, l, gal, min, h) and temperature (c, f).</p>}</div>
  </section>
}

const ZONE_KEY = 'aelys.apps.zones.v1'
const DEFAULT_ZONES = ['Europe/London', 'America/New_York', 'Asia/Tokyo']
const allZones = (): string[] => { try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone') } catch { return DEFAULT_ZONES } }
const loadZones = (): string[] => { try { const v = JSON.parse(localStorage.getItem(ZONE_KEY) ?? 'null'); if (Array.isArray(v) && v.every(z => typeof z === 'string')) return v } catch { /* default */ } return DEFAULT_ZONES }
export const zoneTime = (zone: string, at = new Date()) => { try { return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(at) } catch { return '--:--' } }
export const cityOf = (zone: string) => zone.split('/').pop()!.replace(/_/g, ' ')

export function ZonesApp() {
  const [zones, setZones] = useState(loadZones)
  const [now, setNow] = useState(() => new Date())
  const [pick, setPick] = useState('')
  const options = useMemo(allZones, [])
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 15_000); return () => window.clearInterval(id) }, [])
  const save = (next: string[]) => { setZones(next); try { localStorage.setItem(ZONE_KEY, JSON.stringify(next)) } catch { /* optional */ } }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  return <section className="app-panel" aria-label="Zones">
    <div className="app-list">
      <div className="app-zone"><span><strong>Here</strong><small>{cityOf(local)}</small></span><b>{zoneTime(local, now)}</b></div>
      {zones.map(zone => <div className="app-zone" key={zone}><span><strong>{cityOf(zone)}</strong><small>{zone}</small></span><b>{zoneTime(zone, now)}</b><button type="button" className="app-icon" aria-label={`Remove ${cityOf(zone)}`} onClick={() => save(zones.filter(z => z !== zone))}><X size={14} /></button></div>)}
    </div>
    <div className="app-row"><input className="app-field" list="app-zone-list" aria-label="Add a city or zone" placeholder="Add a zone, e.g. Europe/Paris" value={pick} onChange={e => setPick(e.target.value)} /><datalist id="app-zone-list">{options.map(z => <option key={z} value={z} />)}</datalist>
      <button type="button" className="app-btn" disabled={!options.includes(pick) || zones.includes(pick)} onClick={() => { save([...zones, pick]); setPick('') }}><Plus size={14} />Add</button></div>
  </section>
}

export function DecideApp() {
  const [result, setResult] = useState('')
  const [dice, setDice] = useState(1)
  const [options, setOptions] = useState('Pizza\nSushi\nTacos')
  const choices = options.split('\n').map(item => item.trim()).filter(Boolean)
  return <section className="app-panel" aria-label="Decide">
    <div className="app-row"><button type="button" className="app-btn app-btn--primary" onClick={() => setResult(randomInt(2) ? 'Heads' : 'Tails')}>Flip a coin</button>
      <label className="app-inline">Dice<select className="app-field app-field--narrow" value={dice} onChange={e => setDice(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6].map(n => <option key={n}>{n}</option>)}</select></label>
      <button type="button" className="app-btn" onClick={() => { const rolls = Array.from({ length: dice }, () => randomInt(6) + 1); setResult(dice > 1 ? `${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}` : String(rolls[0])) }}>Roll</button></div>
    <label className="app-stack">Wheel options, one per line<textarea className="app-field app-area" value={options} onChange={e => setOptions(e.target.value.slice(0, 2000))} /></label>
    <div className="app-row"><button type="button" className="app-btn" disabled={choices.length < 2} onClick={() => setResult(choices[randomInt(choices.length)]!)}>Spin the wheel</button></div>
    <output className="app-result" aria-live="polite">{result || 'Your result appears here'}</output>
  </section>
}

const PATTERNS: Record<'Box' | '4-7-8' | 'Calm', readonly number[]> = { Box: [4, 4, 4, 4], '4-7-8': [4, 7, 8, 0], Calm: [5, 0, 5, 0] }
const PHASES = ['Breathe in', 'Hold', 'Breathe out', 'Hold']
export function BreatheApp() {
  const [name, setName] = useState<keyof typeof PATTERNS>('Box')
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState(0)
  const [left, setLeft] = useState(0)
  const pattern = PATTERNS[name]
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!running) return
    let index = 0, remaining = pattern[0]!
    const settle = () => { while (remaining === 0) { index = (index + 1) % 4; remaining = pattern[index]! } }
    settle(); setPhase(index); setLeft(remaining)
    timer.current = window.setInterval(() => {
      remaining--
      if (remaining <= 0) { index = (index + 1) % 4; remaining = pattern[index]!; settle(); setPhase(index) }
      setLeft(remaining)
    }, 1000)
    return () => window.clearInterval(timer.current)
  }, [running, pattern])
  const grown = running && (phase === 0 || phase === 1)
  return <section className="app-panel app-breathe" aria-label="Breathe">
    <div className="app-row">{(Object.keys(PATTERNS) as (keyof typeof PATTERNS)[]).map(key => <button type="button" key={key} className={`app-btn${key === name ? ' app-btn--on' : ''}`} aria-pressed={key === name} onClick={() => { setRunning(false); setName(key) }}>{key}</button>)}</div>
    <div className="app-orb" data-grown={grown} style={{ transitionDuration: `${running ? Math.max(pattern[phase] || 1, 1) : 0.4}s` }}><span aria-live="polite">{running ? PHASES[phase] : 'Ready'}</span>{running && <small>{left}</small>}</div>
    <button type="button" className="app-btn app-btn--primary" onClick={() => setRunning(!running)}>{running ? 'Stop' : 'Start'}</button>
  </section>
}
