import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { EventOut } from '@aelys/shared'
import { ApiError, OfflineQueuedError } from '@aelys/shared'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, MapPin, Plus, RefreshCw } from 'lucide-react'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

const HOURS = Array.from({ length: 12 }, (_, index) => index + 8)
const dayKey = (value: string) => new Date(value).toISOString().slice(0, 10)
const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`

function dayLabel(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) }
function monthLabel(value: Date) { return value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }

function CalendarState({ status, retry }: { status: ApiStatus; retry: () => void }) {
  const copy = status === 'loading' ? ['Loading calendar', 'Checking connected events.'] : status === 'offline' ? ['Calendar is offline', 'Previously saved local changes remain available until the connection returns.'] : ['Calendar is unavailable', 'The calendar API did not respond. Check the connection and try again.']
  return <StateCard status={status} title={copy[0]} description={copy[1]} action={<button className="text-button" type="button" onClick={retry}><RefreshCw size={14} />Try again</button>} />
}

export function CalendarView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [events, setEvents] = useState<readonly EventOut[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [weekOffset, setWeekOffset] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [selectedDate, setSelectedDate] = useState(() => new Date())

  const load = async () => {
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try { setEvents(await getSharedApiClient().calendarEvents()); setStatus('ready') }
    catch { setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error') }
  }
  useEffect(() => { void load() }, [apiStatus])

  const week = useMemo(() => {
    const base = new Date(selectedDate); base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + weekOffset * 7)
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(base); date.setDate(base.getDate() + index); return date })
  }, [selectedDate, weekOffset])

  const createEvent = async (event: FormEvent) => {
    event.preventDefault(); if (!title.trim()) return
    const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1)
    const end = new Date(start); end.setHours(start.getHours() + 1)
    try {
      const operationId = makeOperationId()
      await getSharedApiClient().createCalendarEvent({ title: title.trim(), starts_at: start.toISOString(), ends_at: end.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { idempotencyKey: operationId, offlineEntityKey: `pending:calendar:${operationId}`, offlineEntityValue: { pending: true, title: title.trim(), starts_at: start.toISOString(), ends_at: end.toISOString() } })
      setTitle(''); setFormOpen(false); setMessage('Event saved.'); await load()
    } catch (error) {
      if (error instanceof OfflineQueuedError) { setTitle(''); setFormOpen(false); setMessage('Saved on this device and queued for sync.') }
      else if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`)
      else setMessage('Could not save this event.')
    }
  }

  const eventsByDay = new Map<string, readonly EventOut[]>()
  for (const event of events) { const key = dayKey(event.starts_at); eventsByDay.set(key, [...(eventsByDay.get(key) ?? []), event]) }
  return <div className="calendar-live page">
    <style>{`
      .calendar-live { padding:0 28px 32px; color:#1C1B22; }.calendar-live * { box-sizing:border-box; }
      .cl-toolbar { display:flex; align-items:center; gap:10px; padding:20px 0 16px; }.cl-toolbar h1 { flex:1; margin:0; font:600 22px/30px Inter,-apple-system,sans-serif; }.cl-toolbar p { margin:0 0 0 8px; color:#625D69; font-size:13px; }.cl-btn { height:36px; display:inline-flex; align-items:center; gap:7px; padding:0 12px; border:1px solid #E7E2DE; border-radius:10px; color:#3A3640; background:#fff; cursor:pointer; }.cl-btn--primary { border:0; color:#fff; background:#6A4CF2; }.cl-nav { display:flex; gap:4px; }.cl-icon-btn { width:32px; height:32px; display:grid; place-items:center; border:0; border-radius:9px; color:#625D69; background:transparent; cursor:pointer; }.cl-icon-btn:hover { background:#F1EDEA; }
      .cl-form { display:flex; gap:8px; padding:10px; margin-bottom:14px; border:1px solid #ECE7E3; border-radius:14px; background:rgba(255,255,255,.8); }.cl-form input { min-width:0; flex:1; height:36px; padding:0 10px; border:1px solid #E7E2DE; border-radius:9px; outline:0; }.cl-message { margin:0 0 12px; color:#128A63; font-size:12px; }
      .cl-layout { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:16px; }.cl-surface { min-width:0; overflow:hidden; border:1px solid rgba(255,255,255,.35); border-radius:20px; background:rgba(255,255,255,.88); box-shadow:0 8px 24px rgba(40,30,30,.07); backdrop-filter:blur(20px); }.cl-week-head { display:grid; grid-template-columns:64px repeat(7,minmax(0,1fr)); border-bottom:1px solid #EFEAE6; }.cl-week-head > div { min-height:54px; display:flex; flex-direction:column; justify-content:center; align-items:center; border-left:1px solid #F0EBE7; color:#625D69; font-size:12px; }.cl-week-head > div:first-child { border-left:0; }.cl-week-head .cl-today { color:#5132D6; font-weight:600; }.cl-week-head b { margin-top:3px; font-size:16px; color:inherit; }.cl-grid { position:relative; display:grid; grid-template-columns:64px repeat(7,minmax(0,1fr)); min-height:640px; }.cl-hours { display:grid; grid-template-rows:repeat(12,52px); color:#8D8791; font-size:11px; text-align:right; padding-right:8px; }.cl-hours span { transform:translateY(-7px); }.cl-day { position:relative; border-left:1px solid #F0EBE7; background:repeating-linear-gradient(to bottom, transparent 0, transparent 51px, #F0EBE7 52px); }.cl-day.cl-today { background-color:rgba(106,76,242,.035); }.cl-event { position:absolute; left:6px; right:6px; min-height:34px; overflow:hidden; padding:5px 8px; border:0; border-left:3px solid #6A4CF2; border-radius:8px; color:#3A3640; background:#EEE8FD; text-align:left; cursor:pointer; }.cl-event strong,.cl-event small { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }.cl-event strong { font-size:11px; }.cl-event small { margin-top:2px; font-size:10px; color:#625D69; }
      .cl-side { display:flex; flex-direction:column; gap:16px; }.cl-side-card { padding:16px; }.cl-side-card h2 { margin:0 0 12px; font-size:16px; line-height:24px; }.cl-mini-title { display:flex; align-items:center; margin-bottom:10px; font-weight:600; }.cl-mini-title span { flex:1; }.cl-mini-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; text-align:center; font-size:11px; }.cl-mini-grid b { color:#8D8791; font-weight:500; }.cl-mini-grid span { display:grid; place-items:center; height:28px; border-radius:50%; }.cl-mini-grid .cl-mini-selected { color:#fff; background:#6A4CF2; }.cl-event-list { display:grid; gap:8px; }.cl-event-item { padding:9px 10px; border-left:3px solid #6A4CF2; border-radius:8px; background:#F7F4F1; }.cl-event-item strong,.cl-event-item small { display:block; }.cl-event-item strong { font-size:13px; }.cl-event-item small { margin-top:3px; color:#625D69; font-size:11px; }
      .calendar-live .cl-toolbar h1 { display:none; }.calendar-live .cl-toolbar p { margin-left:auto; }
      @media (max-width:900px) { .cl-layout { grid-template-columns:1fr; }.cl-side { display:grid; grid-template-columns:1fr 1fr; }.cl-side-card:last-child { grid-column:1/-1; } }.cl-week-head,.cl-grid { min-width:720px; }.cl-surface { overflow:auto; }
      @media (max-width:700px) { .calendar-live { padding-inline:2px; }.cl-toolbar { flex-wrap:wrap; }.cl-toolbar h1 { flex-basis:100%; }.cl-side { display:flex; }.cl-side-card:last-child { grid-column:auto; } }
    `}</style>
    <div className="cl-toolbar"><h1>Calendar</h1><p>{monthLabel(selectedDate)}</p><ApiStatusPill status={apiStatus} /><div className="cl-nav"><button className="cl-icon-btn" type="button" aria-label="Previous week" onClick={() => setWeekOffset((value) => value - 1)}><ChevronLeft size={17} /></button><button className="cl-icon-btn" type="button" aria-label="Next week" onClick={() => setWeekOffset((value) => value + 1)}><ChevronRight size={17} /></button></div><button className="cl-btn cl-btn--primary" type="button" onClick={() => setFormOpen((value) => !value)}><Plus size={16} />Create event</button></div>
    {formOpen && <form className="cl-form" onSubmit={createEvent}><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Event title" aria-label="New event title" /><button className="cl-btn cl-btn--primary" type="submit">Save</button><button className="cl-btn" type="button" onClick={() => setFormOpen(false)}>Cancel</button></form>}
    {message && <p className="cl-message" role="status">{message}</p>}
    {status !== 'ready' ? <CalendarState status={status} retry={() => void load()} /> : <div className="cl-layout"><section className="cl-surface"><div className="cl-week-head"><div /><>{week.map((date) => <div key={date.toISOString()} className={dayKey(date.toISOString()) === dayKey(new Date().toISOString()) ? 'cl-today' : ''}><span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span><b>{date.getDate()}</b></div>)}</></div><div className="cl-grid"><div className="cl-hours">{HOURS.map((hour) => <span key={hour}>{`${hour}:00`}</span>)}</div>{week.map((date) => { const eventsForDay = eventsByDay.get(dayKey(date.toISOString())) ?? []; return <div key={date.toISOString()} className={`cl-day ${dayKey(date.toISOString()) === dayKey(new Date().toISOString()) ? 'cl-today' : ''}`}>{eventsForDay.map((event) => { const start = new Date(event.starts_at); const end = new Date(event.ends_at); const top = Math.max(0, (start.getHours() + start.getMinutes() / 60 - 8) * 52); const height = Math.max(34, (end.getTime() - start.getTime()) / 3_600_000 * 52); return <button key={event.id} className="cl-event" style={{ top, height }} type="button"><strong>{event.title}</strong><small>{formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></button> })}</div> })}</div></section><aside className="cl-side"><section className="cl-surface cl-side-card"><h2>Mini calendar</h2><div className="cl-mini-title"><span>{monthLabel(selectedDate)}</span><CalendarDays size={16} /></div><div className="cl-mini-grid">{['M','T','W','T','F','S','S'].map((day) => <b key={day}>{day}</b>)}{Array.from({ length: 35 }, (_, index) => { const date = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), index - 5); const selected = dayKey(date.toISOString()) === dayKey(selectedDate.toISOString()); return <span key={index} className={selected ? 'cl-mini-selected' : ''} onClick={() => setSelectedDate(date)}>{date.getMonth() === selectedDate.getMonth() ? date.getDate() : ''}</span> })}</div></section><section className="cl-surface cl-side-card"><h2>Today’s events</h2><div className="cl-event-list">{(eventsByDay.get(dayKey(new Date().toISOString())) ?? []).map((event) => <div className="cl-event-item" key={event.id}><strong>{event.title}</strong><small><Clock size={12} /> {formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></div>)}{(eventsByDay.get(dayKey(new Date().toISOString())) ?? []).length === 0 && <EmptyCalendar />}</div></section></aside></div>}
  </div>
}

function EmptyCalendar() { return <span style={{ color: '#625D69', fontSize: 13 }}>No events today.</span> }
