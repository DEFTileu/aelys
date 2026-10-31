import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, LocateFixed, MapPin, Moon, RefreshCw, Sun, X } from '../icons'
import { closeWeatherSettings, detectWeatherLocation, disableWeather, openWeatherSettings, refreshWeather, searchCities, selectWeatherCity, useWeather, weatherDescription, type City } from '../lib/weather'

function WeatherIcon({ code, day = true, size = 24 }: { code: number; day?: boolean; size?: number }) {
  const Icon = code === 0 ? day ? Sun : Moon : code <= 3 ? Cloud : code <= 48 ? CloudFog : code <= 67 ? CloudRain : code <= 77 ? CloudSnow : code <= 82 ? CloudRain : code <= 86 ? CloudSnow : CloudLightning
  return <Icon size={size} aria-hidden="true" />
}
const temperature = (value: number) => `${Math.round(value)}°C`

export function WeatherPill() {
  const { location, forecast, status } = useWeather()
  return <button type="button" className="shell-btn shell-pill shell-pill--button weather-pill" data-glass="" aria-label={forecast && location ? `Погода: ${location.name}, ${temperature(forecast.temperature)}. Изменить город` : 'Настроить погоду'} title={location?.name || 'Выбрать город для погоды'} onClick={openWeatherSettings}>
    {forecast ? <WeatherIcon code={forecast.code} day={forecast.isDay} size={18} /> : <CloudSun size={18} aria-hidden="true" />}
    <span>{forecast ? temperature(forecast.temperature) : status === 'loading' ? '…' : 'Город'}</span>
  </button>
}

export function WeatherCard({ compact = false }: { compact?: boolean }) {
  const { location, forecast, status, notice } = useWeather()
  if (!location) return <div className="weather-empty"><CloudSun size={36} aria-hidden="true" /><p>Погода в вашем городе</p><button type="button" className="weather-action" onClick={openWeatherSettings}><MapPin size={15} />Выбрать город</button></div>
  return <div className={`weather-card-body${compact ? ' weather-card-body--compact' : ''}`}>
    <button type="button" className="home-btn weather-location" onClick={openWeatherSettings}><MapPin size={14} /><span>{location.name}</span></button>
    {forecast ? <>
      <div className="weather-current"><WeatherIcon code={forecast.code} day={forecast.isDay} size={38} /><strong>{temperature(forecast.temperature)}</strong></div>
      <div className="weather-description">{weatherDescription(forecast.code)} · ощущается {temperature(forecast.apparent)}</div>
      <div className="weather-forecast">{forecast.days.map((day) => <div key={day.date}><small>{new Date(day.date).toLocaleDateString('ru', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}</small><WeatherIcon code={day.code} size={17} /><span>{Math.round(day.max)}° / {Math.round(day.min)}°</span></div>)}</div>
      <small className="weather-updated">{status === 'error' ? 'Сохранённый прогноз · ' : status === 'loading' ? 'Обновляем · ' : ''}{new Date(forecast.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
    </> : <p role="status">{status === 'loading' ? 'Загружаем погоду…' : notice || 'Погода недоступна.'}</p>}
    <div className="weather-card-footer"><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a><button type="button" className="home-btn" aria-label="Обновить погоду" disabled={status === 'loading'} onClick={() => void refreshWeather(true)}><RefreshCw size={14} /></button></div>
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
      setCities(found); if (!found.length) setMessage('Город не найден. Попробуйте другое название.')
    } catch (error) { if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : 'Не удалось найти город.') }
    finally { if (!request.signal.aborted) setSearching(false) }
  }
  return <div className="weather-settings">
    <p>Выберите город вручную или разрешите определение местоположения.</p>
    <form className="settings-form weather-search" onSubmit={(event) => void submit(event)}>
      <label htmlFor="weather-city-search">Город<input id="weather-city-search" type="search" value={query} maxLength={100} placeholder="Например, Алматы" onChange={(event) => { setQuery(event.target.value); search.current?.abort(); setSearching(false); setCities([]); setMessage('') }} /></label>
      <button type="submit" className="button button--primary" disabled={searching || query.trim().length < 2}>{searching ? 'Ищем…' : 'Найти город'}</button>
    </form>
    {cities.length > 0 && <ul className="weather-cities" aria-label="Найденные города">{cities.map((city) => <li key={city.id}><button type="button" onClick={() => { selectWeatherCity(city); setCities([]); setMessage(`Выбран город: ${city.name}`) }}><MapPin size={16} /><span><strong>{city.name}</strong><small>{city.region}</small></span></button></li>)}</ul>}
    {message && <p role="status">{message}</p>}
    <div className="weather-auto">
      <h3>Определять автоматически</h3>
      <p>После разрешения браузера погода будет обновляться для вашего местоположения. В Open-Meteo отправляются координаты, округлённые до 0,1°; точное положение не сохраняется.</p>
      <button type="button" className="button button--quiet" disabled={locating} onClick={() => { setMessage(''); void detectWeatherLocation() }}><LocateFixed size={16} />{locating ? 'Определяем…' : 'Использовать моё местоположение'}</button>
    </div>
    {location && <div className="weather-selection"><p><strong>{location.name}</strong><br/><small>{location.mode === 'auto' ? 'Автоматическое определение включено' : 'Город выбран вручную'}{status === 'loading' ? ' · загружаем прогноз' : ''}</small></p><button type="button" className="text-button" onClick={() => { disableWeather(); setMessage('Погода отключена') }}>Отключить погоду</button></div>}
    {notice && <p role="status">{notice}</p>}
    <small className="weather-privacy">Город, прогноз и разрешённый автоматический режим сохраняются только в этом браузере. Поиск города и прогноз предоставляет <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>.</small>
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
  return createPortal(<div className="weather-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeWeatherSettings() }}><div ref={panel} role="dialog" aria-modal="true" aria-labelledby="weather-settings-title" className="weather-dialog"><header><h2 id="weather-settings-title">Погода и город</h2><button type="button" className="home-btn" aria-label="Закрыть настройки погоды" onClick={closeWeatherSettings}><X size={21} /></button></header><WeatherSettingsContent /></div></div>, document.body)
}
