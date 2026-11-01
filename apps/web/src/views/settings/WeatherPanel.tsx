import { useEffect, useRef, useState } from 'react'
import { Check, MapPin, Search } from '../../icons'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { detectWeatherLocation, disableWeather, keepWeatherLocation, searchCities, selectWeatherCity, useWeather, type City } from '../../lib/weather'
import { Card, Row, Segmented, SwitchRow } from './ui'

export function WeatherPanel() {
  const { location, notice, locating } = useWeather()
  const { units } = usePrefs()
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<City[]>([])
  const [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  // Typing searches after a short pause; the search is abandoned when the text changes again.
  useEffect(() => {
    request.current?.abort()
    setCities([]); setMessage('')
    if (query.trim().length < 2) return
    const run = new AbortController(); request.current = run
    const timer = window.setTimeout(() => {
      setMessage('Searching…')
      searchCities(query, run.signal).then((found) => { if (!run.signal.aborted) { setCities(found); setMessage(found.length ? '' : 'City not found. Try a different name.') } })
        .catch((error: unknown) => { if (!run.signal.aborted) setMessage(error instanceof Error ? error.message : 'Could not search for cities.') })
    }, 350)
    return () => { window.clearTimeout(timer); run.abort() }
  }, [query])

  const pick = (city: City) => { selectWeatherCity(city); setQuery(''); setMessage(`City selected: ${city.name}`) }
  const here = (city: City) => !!location && location.mode === 'city' && location.latitude === city.latitude && location.longitude === city.longitude
  return <>
    <Card>
      <div className="st-row st-row--14">
        <span className="st-pin"><MapPin size={14} aria-hidden="true" /></span>
        <div className="st-grow"><div className="st-label">{location?.name ?? 'No city selected'}</div><div className="st-hint">Used by Weather and the Home weather widget</div></div>
        {location && <button type="button" className="st-btn" onClick={() => { disableWeather(); setMessage('Weather turned off') }}>Turn off</button>}
      </div>
      <div className="st-citybox">
        <label className="st-citysearch"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search city" placeholder="Search city" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="st-cities" role="listbox" aria-label="Matching cities">
          {!query.trim() && location && <button type="button" role="option" aria-selected className="st-city" onClick={() => undefined}><span><b>{location.name}</b></span><Check size={14} aria-hidden="true" /></button>}
          {cities.slice(0, 4).map((city) => <button key={city.id} type="button" role="option" aria-selected={here(city)} className="st-city" onClick={() => pick(city)}><span><b>{city.name}</b>{city.region && <i> · {city.region}</i>}</span>{here(city) && <Check size={14} aria-hidden="true" />}</button>)}
        </div>
        {message && <div className="st-hint" role="status" style={{ marginTop: 6, padding: '0 10px' }}>{message}</div>}
      </div>
    </Card>
    <Card>
      <Row title="Units" hint="Temperature and wind" wrap>
        <Segmented label="Units" value={units} onChange={(value) => setPrefs({ units: value })} options={[['c', '°C · m/s'], ['f', '°F · mph']]} />
      </Row>
      <SwitchRow title="Use current location" hint="Update the city automatically on this device" checked={location?.mode === 'auto'} pending={locating} onChange={(on) => { if (on) void detectWeatherLocation(); else keepWeatherLocation() }} />
    </Card>
    {notice && <div className="st-note" role="status">{notice}</div>}
    <div className="st-note">City search and forecast by Open-Meteo. Coordinates are rounded to 0.1°; your exact position is not stored.</div>
  </>
}
