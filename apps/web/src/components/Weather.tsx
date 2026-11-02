import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, LocateFixed, MapPin, Moon, RefreshCw, Sun, X } from '../icons'
import { formatTemperature, formatWind, usePrefs } from '../lib/prefs'
import { closeWeatherSettings, detectWeatherLocation, disableWeather, openWeatherSettings, refreshWeather, searchCities, selectWeatherCity, useWeather, weatherDescription, type City } from '../lib/weather'

function WeatherIcon({ code, day = true, size = 24 }: { code: number; day?: boolean; size?: number }) {
  const Icon = code === 0 ? day ? Sun : Moon : code <= 3 ? Cloud : code <= 48 ? CloudFog : code <= 67 ? CloudRain : code <= 77 ? CloudSnow : code <= 82 ? CloudRain : code <= 86 ? CloudSnow : CloudLightning
  return <Icon size={size} aria-hidden="true" />
}

export function WeatherCard({ size = 'S' }: { size?: 'S' | 'M' | 'L' | 'Tall' }) {
  const { location, forecast, status, notice } = useWeather()
  const { units } = usePrefs()
  const temperature = (value: number) => formatTemperature(value, units)
  const deg = (celsius: number) => Math.round(units === 'f' ? celsius * 9 / 5 + 32 : celsius)
  if (!location) return <div className="weather-empty"><button type="button" className="weather-action" onClick={openWeatherSettings}><MapPin size={15} aria-hidden="true" />Set location</button></div>
  const today = forecast?.days[0]
  return <div className={`weather-card-body weather-card-body--${size.toLowerCase()}`}>
    <button type="button" className="home-btn weather-location" onClick={openWeatherSettings}><MapPin size={14} /><span>{location.name}</span></button>
    {forecast ? <>
      <div className="weather-current"><WeatherIcon code={forecast.code} day={forecast.isDay} size={38} /><strong>{temperature(forecast.temperature)}</strong></div>
      <div className="weather-description">{weatherDescription(forecast.code)}</div>
      {size !== 'S' && <div className="weather-details"><span>Feels like {temperature(forecast.apparent)}</span><span>Wind {formatWind(forecast.wind, units)}</span>{today && <span>H {deg(today.max)}° · L {deg(today.min)}°</span>}</div>}
      {(size === 'M' || size === 'L') && !!forecast.hours?.length && <div className="weather-hourly" aria-label="Next hours">{forecast.hours.map((hour) => <div key={hour.time}><small>{new Date(hour.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })}</small><WeatherIcon code={hour.code} size={17} /><span>{deg(hour.temperature)}°</span></div>)}</div>}
      {(size === 'L' || size === 'Tall') && <div className="weather-forecast">{forecast.days.slice(0, 5).map((day) => <div key={day.date}><small>{new Date(day.date).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' })}</small><WeatherIcon code={day.code} size={17} /><span>{deg(day.max)}° / {deg(day.min)}°</span></div>)}</div>}
      {size !== 'S' && <small className="weather-updated">{status === 'error' ? 'Saved forecast · ' : status === 'loading' ? 'Updating · ' : ''}{new Date(forecast.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>}
    </> : status === 'loading' ? <p role="status">Loading weather…</p> : <div className="wb-empty"><span>Can’t load</span><button type="button" className="home-btn wb-action" onClick={() => void refreshWeather(true)}>Retry</button></div>}
    {notice && !forecast && <small className="weather-updated">{notice}</small>}
    <div className="weather-card-footer"><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a><button type="button" className="home-btn" aria-label="Refresh weather" disabled={status === 'loading'} onClick={() => void refreshWeather(true)}><RefreshCw size={14} /></button></div>
  </div>
}

export function WeatherSettingsContent() {
  const { location, notice, locating, status } = useWeather()
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<City[]>([])
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')
  const search = useRef<AbortController | null>(null)
  useEffect(() => () => search.current?.abort(), [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (query.trim().length < 2) return
    search.current?.abort(); const request = new AbortController(); search.current = request
    setSearching(true); setCities([]); setMessage('')
    try {
      const found = await searchCities(query, request.signal)
      if (request.signal.aborted) return
      setCities(found); if (!found.length) setMessage('City not found. Try a different name.')
    } catch (error) { if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Could not search for cities.') }
    finally { if (!request.signal.aborted) setSearching(false) }
  }
  return <div className="weather-settings">
    <p>Choose a city manually or allow location detection.</p>
    <form className="settings-form weather-search" onSubmit={(event) => void submit(event)}>
      <label htmlFor="weather-city-search">City<input id="weather-city-search" type="search" value={query} maxLength={100} placeholder="For example, London" onChange={(event) => { setQuery(event.target.value); search.current?.abort(); setSearching(false); setCities([]); setMessage('') }} /></label>
      <button type="submit" className="button button--primary" disabled={searching || query.trim().length < 2}>{searching ? 'Searching…' : 'Find city'}</button>
    </form>
    {cities.length > 0 && <ul className="weather-cities" aria-label="Matching cities">{cities.map((city) => <li key={city.id}><button type="button" onClick={() => { selectWeatherCity(city); setCities([]); setMessage(`City selected: ${city.name}`) }}><MapPin size={16} /><span><strong>{city.name}</strong><small>{city.region}</small></span></button></li>)}</ul>}
    {message && <p role="status">{message}</p>}
    <div className="weather-auto">
      <h3>Detect automatically</h3>
      <p>Once your browser allows it, the weather updates for your location. Open-Meteo receives coordinates rounded to 0.1°; your exact position is not stored.</p>
      <button type="button" className="button button--quiet" disabled={locating} onClick={() => { setMessage(''); void detectWeatherLocation() }}><LocateFixed size={16} />{locating ? 'Detecting…' : 'Use my location'}</button>
    </div>
    {location && <div className="weather-selection"><p><strong>{location.name}</strong><br/><small>{location.mode === 'auto' ? 'Automatic location on' : 'City chosen manually'}{status === 'loading' ? ' · loading forecast' : ''}</small></p><button type="button" className="text-button" onClick={() => { disableWeather(); setMessage('Weather turned off') }}>Turn off weather</button></div>}
    {notice && <p role="status">{notice}</p>}
    <small className="weather-privacy">The city, forecast and allowed automatic mode are stored in this browser only. City search and forecast are provided by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>.</small>
  </div>
}

export function WeatherSettingsDialog() {
  const { settingsOpen } = useWeather()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!settingsOpen) return
    const before = document.activeElement as HTMLElement | null
    const dialog = panel.current
    dialog?.querySelector<HTMLElement>('input,button')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeWeatherSettings() }
      if (event.key === 'Tab' && dialog) {
        const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,a[href]')]
        const next = event.shiftKey ? focusable.at(-1) : focusable[0]
        if ((event.shiftKey && document.activeElement === focusable[0]) || (!event.shiftKey && document.activeElement === focusable.at(-1))) { event.preventDefault(); next?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); before?.focus() }
  }, [settingsOpen])
  if (!settingsOpen) return null
  return createPortal(<div className="weather-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeWeatherSettings() }}><div ref={panel} role="dialog" aria-modal="true" aria-labelledby="weather-settings-title" className="weather-dialog"><header><h2 id="weather-settings-title">Weather and city</h2><button type="button" className="home-btn" aria-label="Close weather settings" onClick={closeWeatherSettings}><X size={21} /></button></header><WeatherSettingsContent /></div></div>, document.body)
}
