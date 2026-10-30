import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { CalendarReminder, EventOccurrence, EventOut } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Plus, RefreshCw } from '../icons'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

const HOURS = Array.from({ length: 24 }, (_, index) => index)
const dayKey = (value: string) => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function monthLabel(value: Date) { return value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }
function localInputDate(value: Date) { return `${dayKey(value.toISOString())}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}` }

function CalendarState({ status, retry }: { status: ApiStatus; retry: () => void }) {
  const copy = status === 'loading' ? ['Loading calendar', 'Checking connected events.'] : status === 'offline' ? ['Calendar is offline', 'Reconnect to load or create events.'] : ['Calendar is unavailable', 'The calendar API did not respond. Check the connection and try again.']
  return <StateCard status={status} title={copy[0]} description={copy[1]} action={<button className="text-button" type="button" onClick={retry}><RefreshCw size={14} />Try again</button>} />
}

export function CalendarView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [events, setEvents] = useState<readonly EventOccurrence[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [weekOffset, setWeekOffset] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [rrule, setRrule] = useState('')
  const [reminderAt, setReminderAt] = useState('')
  const [reminders, setReminders] = useState<readonly CalendarReminder[]>([])
  const operationKey = useRef(crypto.randomUUID())
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<EventOut | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedDate, setSelectedDate] = useState(() => new Date())

  const week = useMemo(() => {
    const base = new Date(selectedDate); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + weekOffset * 7)
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(base); date.setDate(base.getDate() + index); return date })
  }, [selectedDate, weekOffset])
  const load = async () => {
    setStatus(apiStatus === 'ready' ? 'loading' : apiStatus)
    const end = new Date(week[0]); end.setDate(end.getDate() + 7)
    try { setEvents(await getSharedApiClient().calendarOccurrences(week[0].toISOString(), end.toISOString())); setStatus('ready') }
    catch (error) { setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error'); if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`) }
  }
  useEffect(() => { void load() }, [apiStatus, week])

  const openCreate = () => {
    const start = new Date(selectedDate)
    start.setDate(start.getDate() + weekOffset * 7)
    start.setHours(9, 0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    setStartsAt(localInputDate(start)); setEndsAt(localInputDate(end)); setRrule(''); setReminderAt(''); setMessage(''); setFormOpen(true)
    setEditing(null); setConfirmDelete(false); setTitle('')
    setReminders([]); operationKey.current = crypto.randomUUID()
  }

  const editEvent = (occurrence: EventOccurrence) => {
    const event: EventOut = { ...occurrence, starts_at: occurrence.series_starts_at, ends_at: occurrence.series_ends_at }
    setEditing(event); setConfirmDelete(false); setTitle(event.title); setRrule(event.rrule ?? ''); setReminderAt('')
    setStartsAt(localInputDate(new Date(event.starts_at))); setEndsAt(localInputDate(new Date(event.ends_at)))
    setMessage(''); setFormOpen(true)
    setReminders([])
    void getSharedApiClient().calendarReminders(event.id).then(setReminders).catch(() => setMessage('Could not load reminders.'))
  }
  const deleteEvent = async () => {
    if (!editing || saving) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setSaving(true)
    try { await getSharedApiClient().deleteCalendarEvent(editing.id, editing.version, { queueOnOffline: false }); setFormOpen(false); setEditing(null); setMessage('Event deleted.'); await load() }
    catch (error) { setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not confirm deletion. Reload the calendar to check.') }
    finally { setSaving(false) }
  }

  const createEvent = async (event: FormEvent) => {
    event.preventDefault(); if (!title.trim() || saving) return
    const start = new Date(startsAt)
    const end = new Date(endsAt)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) { setMessage('Choose a valid start and an end after it.'); return }
    const reminder = reminderAt ? new Date(reminderAt) : null
    if (reminder && (!Number.isFinite(reminder.getTime()) || reminder >= start)) { setMessage('Reminder must be before the event start.'); return }
    if (apiStatus !== 'ready') { setMessage('Connect to the API before creating an event.'); return }
    setSaving(true)
    try {
      const body = { ...(editing ?? {}), title: title.trim(), starts_at: start.toISOString(), ends_at: end.toISOString(), timezone: editing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, rrule: rrule.trim() || null, reminder_at: reminder?.toISOString() ?? null }
      if (editing) await getSharedApiClient().updateCalendarEvent(editing.id, { ...body, version: editing.version }, { queueOnOffline: false })
      else await getSharedApiClient().createCalendarEvent(body, { queueOnOffline: false, idempotencyKey: operationKey.current })
      setTitle(''); setFormOpen(false); setMessage('Event saved.'); await load()
    } catch (error) {
      if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`)
      else setMessage('Could not save this event.')
    } finally { setSaving(false) }
  }

  const eventsByDay = new Map<string, readonly EventOccurrence[]>()
  for (const event of events) { const key = dayKey(event.starts_at); eventsByDay.set(key, [...(eventsByDay.get(key) ?? []), event]) }
  return <div className="calendar-live page">
    <style>{`
      .calendar-live { padding:0 28px 32px; color:#1C1B22; }.calendar-live * { box-sizing:border-box; }
      .cl-toolbar { display:flex; align-items:center; gap:10px; padding:20px 0 16px; }.cl-toolbar h1 { flex:1; margin:0; font:600 22px/30px Inter,-apple-system,sans-serif; }.cl-toolbar p { margin:0 0 0 8px; color:#625D69; font-size:13px; }.cl-btn { height:36px; display:inline-flex; align-items:center; gap:7px; padding:0 12px; border:1px solid #E7E2DE; border-radius:10px; color:#3A3640; background:#fff; cursor:pointer; }.cl-btn--primary { border:0; color:#fff; background:#6A4CF2; }.cl-nav { display:flex; gap:4px; }.cl-icon-btn { width:32px; height:32px; display:grid; place-items:center; border:0; border-radius:9px; color:#625D69; background:transparent; cursor:pointer; }.cl-icon-btn:hover { background:#F1EDEA; }
      .cl-form { display:flex; flex-wrap:wrap; align-items:end; gap:8px; padding:10px; margin-bottom:14px; border:1px solid #ECE7E3; border-radius:14px; background:rgba(255,255,255,.8); }.cl-form input { min-width:0; flex:1; height:36px; padding:0 10px; border:1px solid #E7E2DE; border-radius:9px; outline:0; }.cl-message { margin:0 0 12px; color:#128A63; font-size:12px; }
      .cl-layout { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:16px; }.cl-surface { min-width:0; overflow:hidden; border:1px solid rgba(255,255,255,.35); border-radius:20px; background:rgba(255,255,255,.88); box-shadow:0 8px 24px rgba(40,30,30,.07); backdrop-filter:blur(20px); }.cl-week-head { display:grid; grid-template-columns:64px repeat(7,minmax(0,1fr)); border-bottom:1px solid #EFEAE6; }.cl-week-head > div { min-height:54px; display:flex; flex-direction:column; justify-content:center; align-items:center; border-left:1px solid #F0EBE7; color:#625D69; font-size:12px; }.cl-week-head > div:first-child { border-left:0; }.cl-week-head .cl-today { color:#5132D6; font-weight:600; }.cl-week-head b { margin-top:3px; font-size:16px; color:inherit; }.cl-grid { position:relative; display:grid; grid-template-columns:64px repeat(7,minmax(0,1fr)); min-height:1248px; }.cl-hours { display:grid; grid-template-rows:repeat(24,52px); color:#8D8791; font-size:11px; text-align:right; padding-right:8px; }.cl-hours span { transform:translateY(-7px); }.cl-day { position:relative; border-left:1px solid #F0EBE7; background:repeating-linear-gradient(to bottom, transparent 0, transparent 51px, #F0EBE7 52px); }.cl-day.cl-today { background-color:rgba(106,76,242,.035); }.cl-event { position:absolute; left:6px; right:6px; min-height:34px; overflow:hidden; padding:5px 8px; border:0; border-left:3px solid #6A4CF2; border-radius:8px; color:#3A3640; background:#EEE8FD; text-align:left; cursor:pointer; }.cl-event strong,.cl-event small { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }.cl-event strong { font-size:11px; }.cl-event small { margin-top:2px; font-size:10px; color:#625D69; }
      .cl-side { display:flex; flex-direction:column; gap:16px; }.cl-side-card { padding:16px; }.cl-side-card h2 { margin:0 0 12px; font-size:16px; line-height:24px; }.cl-mini-title { display:flex; align-items:center; margin-bottom:10px; font-weight:600; }.cl-mini-title span { flex:1; }.cl-mini-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; text-align:center; font-size:11px; }.cl-mini-grid b { color:#8D8791; font-weight:500; }.cl-mini-grid span { display:grid; place-items:center; height:28px; border-radius:50%; }.cl-mini-grid .cl-mini-selected { color:#fff; background:#6A4CF2; }.cl-event-list { display:grid; gap:8px; }.cl-event-item { padding:9px 10px; border-left:3px solid #6A4CF2; border-radius:8px; background:#F7F4F1; }.cl-event-item strong,.cl-event-item small { display:block; }.cl-event-item strong { font-size:13px; }.cl-event-item small { margin-top:3px; color:#625D69; font-size:11px; }
      .calendar-live .cl-toolbar h1 { display:none; }.calendar-live .cl-toolbar p { margin-left:auto; }
      @media (max-width:900px) { .cl-layout { grid-template-columns:1fr; }.cl-side { display:grid; grid-template-columns:1fr 1fr; }.cl-side-card:last-child { grid-column:1/-1; } }.cl-week-head,.cl-grid { min-width:720px; }.cl-surface { overflow:auto; }
      @media (max-width:700px) { .calendar-live { padding-inline:2px; }.cl-toolbar { flex-wrap:wrap; }.cl-toolbar h1 { flex-basis:100%; }.cl-side { display:flex; }.cl-side-card:last-child { grid-column:auto; } }
    `}</style>
    <div className="cl-toolbar"><h1>Calendar</h1><p>{monthLabel(week[0])}</p><ApiStatusPill status={apiStatus} /><div className="cl-nav"><button className="cl-icon-btn" type="button" aria-label="Previous week" onClick={() => setWeekOffset((value) => value - 1)}><ChevronLeft size={17} /></button><button className="cl-icon-btn" type="button" aria-label="Next week" onClick={() => setWeekOffset((value) => value + 1)}><ChevronRight size={17} /></button></div><button className="cl-btn cl-btn--primary" type="button" onClick={openCreate}><Plus size={16} />Create event</button></div>
    {formOpen && <form className="cl-form" onSubmit={createEvent}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Event title" aria-label="New event title" /><label>Start<input required type="datetime-local" aria-label="Event start" value={startsAt} onInput={(event) => setStartsAt(event.currentTarget.value)} onChange={(event) => setStartsAt(event.target.value)} /></label><label>End<input required type="datetime-local" aria-label="Event end" value={endsAt} onInput={(event) => setEndsAt(event.currentTarget.value)} onChange={(event) => setEndsAt(event.target.value)} /></label>{editing?.rrule && <p>Editing the entire recurring series.</p>}<label>Repeat (RRULE)<input aria-label="Event recurrence" value={rrule} onChange={(event) => setRrule(event.target.value)} placeholder="FREQ=WEEKLY;COUNT=4" /></label><label>Reminder (same lead time on repeats)<input aria-label="Event reminder" type="datetime-local" value={reminderAt} onInput={(event) => setReminderAt(event.currentTarget.value)} onChange={(event) => setReminderAt(event.target.value)} /></label><button className="cl-btn cl-btn--primary" type="submit" disabled={saving || apiStatus !== 'ready'}>{saving ? 'Saving…' : 'Save'}</button><button className="cl-btn" type="button" disabled={saving} onClick={() => setFormOpen(false)}>Cancel</button>{editing && <button className="cl-btn" type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => void deleteEvent()}>{confirmDelete ? 'Confirm delete' : 'Delete event'}</button>}</form>}
    {formOpen && editing && <section aria-label="Event reminders">{reminders.map((reminder) => <p key={reminder.id}>{new Date(reminder.notify_at).toLocaleString()} · {reminder.reminder_status} <button type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => { setSaving(true); void getSharedApiClient().cancelCalendarReminder(editing.id, reminder.id, reminder.version, { queueOnOffline: false }).then(async () => setReminders(await getSharedApiClient().calendarReminders(editing.id))).catch((error) => setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not cancel reminder.')).finally(() => setSaving(false)) }}>Cancel reminder</button></p>)}</section>}
    {apiStatus !== 'ready' && <p role="status">Calendar is offline or unavailable. Previously loaded events may be shown from cache. Changes require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {message && <p className="cl-message" role="status">{message}</p>}
    {status !== 'ready' ? <CalendarState status={status} retry={() => void load()} /> : <div className="cl-layout"><section className="cl-surface"><div className="cl-week-head"><div /><>{week.map((date) => <div key={date.toISOString()} className={dayKey(date.toISOString()) === dayKey(new Date().toISOString()) ? 'cl-today' : ''}><span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span><b>{date.getDate()}</b></div>)}</></div><div className="cl-grid"><div className="cl-hours">{HOURS.map((hour) => <span key={hour}>{`${hour}:00`}</span>)}</div>{week.map((date) => { const eventsForDay = eventsByDay.get(dayKey(date.toISOString())) ?? []; return <div key={date.toISOString()} className={`cl-day ${dayKey(date.toISOString()) === dayKey(new Date().toISOString()) ? 'cl-today' : ''}`}>{eventsForDay.map((event) => { const start = new Date(event.starts_at); const end = new Date(event.ends_at); const top = Math.max(0, (start.getHours() + start.getMinutes() / 60) * 52); const height = Math.max(34, (end.getTime() - start.getTime()) / 3_600_000 * 52); return <button key={event.occurrence_id} className="cl-event" style={{ top, height }} type="button" onClick={() => editEvent(event)}><strong>{event.title}</strong><small>{formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></button> })}</div> })}</div></section><aside className="cl-side"><section className="cl-surface cl-side-card"><h2>Mini calendar</h2><div className="cl-mini-title"><span>{monthLabel(selectedDate)}</span><CalendarDays size={16} /></div><div className="cl-mini-grid">{['M','T','W','T','F','S','S'].map((day, index) => <b key={index}>{day}</b>)}{Array.from({ length: 42 }, (_, index) => { const first = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1); const date = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), index + 1 - ((first.getDay() + 6) % 7)); const selected = dayKey(date.toISOString()) === dayKey(selectedDate.toISOString()); return <span key={index} className={selected ? 'cl-mini-selected' : ''} onClick={() => { setSelectedDate(date); setWeekOffset(0) }}>{date.getMonth() === selectedDate.getMonth() ? date.getDate() : ''}</span> })}</div></section><section className="cl-surface cl-side-card"><h2>Today’s events</h2><div className="cl-event-list">{(eventsByDay.get(dayKey(new Date().toISOString())) ?? []).map((event) => <div className="cl-event-item" key={event.occurrence_id}><strong>{event.title}</strong><small><Clock size={12} /> {formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></div>)}{(eventsByDay.get(dayKey(new Date().toISOString())) ?? []).length === 0 && <EmptyCalendar />}</div></section></aside></div>}
  </div>
}

function EmptyCalendar() { return <span style={{ color: '#625D69', fontSize: 13 }}>No events today.</span> }
