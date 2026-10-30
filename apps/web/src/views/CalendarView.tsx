import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { CalendarReminder, EventOccurrence, EventOut } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { ChevronLeft, ChevronRight, Clock, Plus, RefreshCw } from '../icons'
import './actual-calendar.css'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

const HOURS = Array.from({ length: 24 }, (_, index) => index)
const dayKey = (value: string) => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

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
  const [visibleMonth, setVisibleMonth] = useState(() => { const date = new Date(); return new Date(date.getFullYear(), date.getMonth(), 1) })
  const requestGeneration = useRef(0)

  const week = useMemo(() => {
    const base = new Date(selectedDate); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + weekOffset * 7)
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(base); date.setDate(base.getDate() + index); return date })
  }, [selectedDate, weekOffset])
  const currentRange = useRef({ week, apiStatus })
  currentRange.current = { week, apiStatus }
  const load = async () => {
    const generation = ++requestGeneration.current
    const { week: requestedWeek, apiStatus: requestedStatus } = currentRange.current
    setStatus(requestedStatus === 'ready' ? 'loading' : requestedStatus)
    const end = new Date(requestedWeek[0]); end.setDate(end.getDate() + 7)
    try {
      const result = await getSharedApiClient().calendarOccurrences(requestedWeek[0].toISOString(), end.toISOString())
      if (generation === requestGeneration.current) { setEvents(result); setStatus('ready') }
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
      if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`)
    }
  }
  useEffect(() => { void load(); return () => { requestGeneration.current += 1 } }, [apiStatus, week])
  useEffect(() => {
    const date = new Date(selectedDate); date.setDate(date.getDate() + weekOffset * 7)
    setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1))
  }, [selectedDate, weekOffset])

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
  const weekScroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (status === 'ready' && weekScroll.current) weekScroll.current.scrollTop = 8 * 52 }, [status, weekOffset])
  const selectedDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toISOString()
  const zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zoneOffset = new Intl.DateTimeFormat(undefined, { timeZoneName: 'shortOffset' }).formatToParts(week[0]).find(part => part.type === 'timeZoneName')?.value ?? zoneName

  return <div className="calendar-live page">
    <div className="cl-toolbar"><ApiStatusPill status={apiStatus} /><button className="cl-btn cl-btn--primary" type="button" onClick={openCreate}><Plus size={16} />Create event</button></div>
    {formOpen && <form className="cl-form" onSubmit={createEvent}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Event title" aria-label="New event title" /><label>Start<input required type="datetime-local" aria-label="Event start" value={startsAt} onInput={(event) => setStartsAt(event.currentTarget.value)} onChange={(event) => setStartsAt(event.target.value)} /></label><label>End<input required type="datetime-local" aria-label="Event end" value={endsAt} onInput={(event) => setEndsAt(event.currentTarget.value)} onChange={(event) => setEndsAt(event.target.value)} /></label>{editing?.rrule && <p>Editing the entire recurring series.</p>}<label>Repeat (RRULE)<input aria-label="Event recurrence" value={rrule} onChange={(event) => setRrule(event.target.value)} placeholder="FREQ=WEEKLY;COUNT=4" /></label><label>Reminder (same lead time on repeats)<input aria-label="Event reminder" type="datetime-local" value={reminderAt} onInput={(event) => setReminderAt(event.currentTarget.value)} onChange={(event) => setReminderAt(event.target.value)} /></label><button className="cl-btn cl-btn--primary" type="submit" disabled={saving || apiStatus !== 'ready'}>{saving ? 'Saving…' : 'Save'}</button><button className="cl-btn" type="button" disabled={saving} onClick={() => setFormOpen(false)}>Cancel</button>{editing && <button className="cl-btn" type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => void deleteEvent()}>{confirmDelete ? 'Confirm delete' : 'Delete event'}</button>}</form>}
    {formOpen && editing && <section aria-label="Event reminders">{reminders.map((reminder) => <p key={reminder.id}>{new Date(reminder.notify_at).toLocaleString()} · {reminder.reminder_status} <button type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => { setSaving(true); void getSharedApiClient().cancelCalendarReminder(editing.id, reminder.id, reminder.version, { queueOnOffline: false }).then(async () => setReminders(await getSharedApiClient().calendarReminders(editing.id))).catch((error) => setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not cancel reminder.')).finally(() => setSaving(false)) }}>Cancel reminder</button></p>)}</section>}
    {apiStatus !== 'ready' && <p role="status">Calendar is offline or unavailable. Previously loaded events may be shown from cache. Changes require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {message && <p className="cl-message" role="status">{message}</p>}
    {status !== 'ready' ? <CalendarState status={status} retry={() => void load()} /> : <div className="cl-layout"><section className="cl-surface cl-week"><div className="cl-week-toolbar"><button className="cl-btn" type="button" onClick={() => { setSelectedDate(new Date()); setWeekOffset(0) }}>Today</button><div className="cl-nav"><button className="cl-btn cl-nav-button" type="button" aria-label="Previous week" onClick={() => setWeekOffset((value) => value - 1)}><ChevronLeft size={17} /></button><button className="cl-btn cl-nav-button" type="button" aria-label="Next week" onClick={() => setWeekOffset((value) => value + 1)}><ChevronRight size={17} /></button></div><div className="cl-range"><strong>{week[0].toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} – {week[6].toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</strong><span>Week view</span></div></div><div className="cl-week-head"><div className="cl-zone" title={zoneName}>{zoneOffset}</div><>{week.map((date) => <button type="button" key={date.toISOString()} className={`${dayKey(date.toISOString()) === dayKey(new Date().toISOString()) ? 'cl-today' : ''} ${dayKey(date.toISOString()) === dayKey(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toISOString()) ? 'cl-selected' : ''}`} onClick={() => { setSelectedDate(date); setWeekOffset(0) }}><span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span><b>{date.getDate()}</b></button>)}</></div><div className="cl-grid-scroll" ref={weekScroll} role="region" aria-label="Week schedule" tabIndex={0}><div className="cl-grid"><div className="cl-hours">{HOURS.map((hour) => <span key={hour}>{`${hour}:00`}</span>)}</div>{week.map((date) => { const eventsForDay = eventsByDay.get(dayKey(date.toISOString())) ?? []; return <div key={date.toISOString()} className={`cl-day ${dayKey(date.toISOString()) === dayKey(new Date().toISOString()) ? 'cl-today' : ''} ${dayKey(date.toISOString()) === dayKey(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toISOString()) ? 'cl-selected' : ''}`}>{eventsForDay.map((event) => { const start = new Date(event.starts_at); const end = new Date(event.ends_at); const top = Math.max(0, (start.getHours() + start.getMinutes() / 60) * 52); const height = Math.max(34, (end.getTime() - start.getTime()) / 3_600_000 * 52); return <button key={event.occurrence_id} className="cl-event" style={{ top, height }} type="button" onClick={() => editEvent(event)}><strong>{event.title}</strong><small>{formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></button> })}</div> })}</div></div><div className="cl-mobile-agenda"><h2>{new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h2>{(eventsByDay.get(dayKey(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toISOString())) ?? []).map(event => <div className="cl-mobile-event" key={event.occurrence_id} role="button" tabIndex={0} onClick={() => editEvent(event)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editEvent(event) } }}><span>{formatTime(event.starts_at)}</span><div><strong>{event.title}</strong><small>{formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></div></div>)}{!(eventsByDay.get(dayKey(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toISOString())) ?? []).length && <p>No events on this day.</p>}</div></section><aside className="cl-side"><section className="cl-surface cl-side-card"><div className="cl-mini-title"><span>{monthLabel(visibleMonth)}</span><button className="cl-icon-btn" type="button" aria-label="Previous month" onClick={() => { const date = new Date(visibleMonth); date.setMonth(date.getMonth() - 1); setSelectedDate(date); setWeekOffset(0) }}><ChevronLeft size={16} /></button><button className="cl-icon-btn" type="button" aria-label="Next month" onClick={() => { const date = new Date(visibleMonth); date.setMonth(date.getMonth() + 1); setSelectedDate(date); setWeekOffset(0) }}><ChevronRight size={16} /></button></div><div className="cl-mini-grid">{['M','T','W','T','F','S','S'].map((day, index) => <b key={index}>{day}</b>)}{Array.from({ length: 42 }, (_, index) => { const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1); const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), index + 1 - ((first.getDay() + 6) % 7)); const selected = dayKey(date.toISOString()) === dayKey(selectedDay); return <button type="button" key={index} className={selected ? 'cl-mini-selected' : ''} aria-pressed={selected} aria-label={date.toLocaleDateString(undefined, { dateStyle: 'full' })} onClick={() => { setSelectedDate(date); setWeekOffset(0) }}>{date.getDate()}</button> })}</div></section><section className="cl-surface cl-side-card"><h2>{dayKey(selectedDay) === dayKey(new Date().toISOString()) ? 'Today’s events' : 'Selected day'}</h2><div className="cl-event-list">{(eventsByDay.get(dayKey(selectedDay)) ?? []).map((event) => <div className="cl-event-item" key={event.occurrence_id}><strong>{event.title}</strong><small><Clock size={12} /> {formatTime(event.starts_at)} – {formatTime(event.ends_at)}</small></div>)}{(eventsByDay.get(dayKey(selectedDay)) ?? []).length === 0 && <EmptyCalendar />}</div></section></aside></div>}
  </div>
}

function EmptyCalendar() { return <span className="cl-empty">No events on this day.</span> }
