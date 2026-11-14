import { useEffect, useRef, useState, type FormEvent } from 'react'
import { companion } from '../../../lib/companion/api'
import type { CompanionWeather } from '../../../lib/companion/types'
import { searchCities, type City } from '../../../lib/weather'
import { Card, Row } from '../ui'

const FAILED = 'Something went wrong. Check the connection and try again.'

/** The owner's weather city for the board. Off until a city is chosen; the server keeps it rounded to ~10 km and fetches the forecast itself. */
export function WeatherOnAelys() {
  const [saved, setSaved] = useState<CompanionWeather | null>(null)
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<City[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    companion.weather().then((w) => { if (alive.current) setSaved(w) }, () => { if (alive.current) setMessage(FAILED) })
    return () => { alive.current = false }
  }, [])

  const find = async (event: FormEvent) => {
    event.preventDefault()
    if (query.trim().length < 2 || busy) return
    setBusy(true); setCities([]); setMessage('')
    try {
      const found = await searchCities(query)
      if (!alive.current) return
      setCities(found)
      if (!found.length) setMessage('City not found. Try a different name.')
    } catch (e) { if (alive.current) setMessage(e instanceof Error ? e.message : FAILED) }
    finally { if (alive.current) setBusy(false) }
  }
  const choose = async (city: City) => {
    setBusy(true); setMessage('')
    try {
      const next = await companion.setWeather({ name: city.name.slice(0, 64), lat: city.latitude, lon: city.longitude })
      if (alive.current) { setSaved(next); setCities([]); setQuery('') }
    } catch { if (alive.current) setMessage(FAILED) }
    finally { if (alive.current) setBusy(false) }
  }
  const turnOff = async () => {
    setBusy(true); setMessage('')
    try { const next = await companion.clearWeather(); if (alive.current) setSaved(next) }
    catch { if (alive.current) setMessage(FAILED) }
    finally { if (alive.current) setBusy(false) }
  }

  return <>
    <Card>
      {saved?.name
        ? <Row title={saved.name} hint="Aelys shows the weather here"><button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => void turnOff()}>Turn off</button></Row>
        : <Row title="Off" hint="Choose a city to show its weather on Aelys" />}
      <form className="st-block dv-form" onSubmit={(e) => void find(e)}>
        <label className="st-field-label">City<input className="st-input" type="search" aria-label="City" value={query} maxLength={100} placeholder="For example, London" disabled={busy} onChange={(e) => { setQuery(e.target.value); setCities([]); setMessage('') }} /></label>
        <button type="submit" className="st-btn" disabled={busy || query.trim().length < 2}>Find city</button>
      </form>
      {cities.length > 0 && <ul className="st-list" aria-label="Matching cities">{cities.map((c) => <li key={c.id}><Row title={c.name} hint={c.region}><button type="button" className="st-btn" disabled={busy} onClick={() => void choose(c)}>Use</button></Row></li>)}</ul>}
      {message && <div className="st-error" role="alert">{message}</div>}
    </Card>
    <div className="st-hint">Aelys' server stores your city with coordinates rounded to about 10 km and fetches the forecast from Open-Meteo, so it works while your Mac is off.</div>
  </>
}
