import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { CalendarReminder, EventOccurrence, EventOut } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import { GRID_PAD, HOUR_PX, dayKey, hourOf, localInputDate } from './calendarUtils'

// All calendar state and handlers; the desktop and mobile compositions only differ in markup.
export function useCalendar(apiStatus: ApiStatus) {
  const [events, setEvents] = useState<readonly EventOccurrence[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [weekOffset, setWeekOffset] = useState(0)
  const [assistantDraft, setAssistantDraft] = useState('')
  const [showWeekends, setShowWeekends] = useState(false)
  const [calendarView, setCalendarView] = useState<'month' | 'week' | 'day'>('week')
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [rrule, setRrule] = useState('')
  const [reminderAt, setReminderAt] = useState('')
  const [reminders, setReminders] = useState<readonly CalendarReminder[]>([])
  const operationKey = useRef(crypto.randomUUID())
  const createBaseline = useRef<{ startsAt: string; endsAt: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<EventOut | null>(null)
  const [externalEvent, setExternalEvent] = useState<EventOut | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState('')
  const [parkedEvent, setParkedEvent] = useState<{ title: string; startsAt: string; endsAt: string; rrule: string; reminderAt: string; editing: EventOut; reminders: readonly CalendarReminder[] } | null>(null)
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [visibleMonth, setVisibleMonth] = useState(() => { const date = new Date(); return new Date(date.getFullYear(), date.getMonth(), 1) })
  const requestGeneration = useRef(0)

  const week = useMemo(() => {
    const base = new Date(selectedDate); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + weekOffset * 7)
    return Array.from({ length: 7 }, (_, index) => { const date = new Date(base); date.setDate(base.getDate() + index); return date })
  }, [selectedDate, weekOffset])
  const range = useMemo(() => {
    if (calendarView !== 'month') return week
    const first = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1)
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7))
    return Array.from({ length: 42 }, (_, index) => { const date = new Date(first); date.setDate(first.getDate() + index); return date })
  }, [calendarView, selectedDate, week])
  const currentRange = useRef({ range, apiStatus })
  currentRange.current = { range, apiStatus }
  const load = async () => {
    const generation = ++requestGeneration.current
    const { range: requestedWeek, apiStatus: requestedStatus } = currentRange.current
    setStatus(requestedStatus === 'ready' ? 'loading' : requestedStatus)
    const end = new Date(requestedWeek[0]); end.setDate(end.getDate() + requestedWeek.length)
    try {
      const result = await getSharedApiClient().calendarOccurrences(requestedWeek[0].toISOString(), end.toISOString())
      if (generation === requestGeneration.current) { setEvents(result); setStatus('ready') }
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
      if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`)
    }
  }
  useEffect(() => { void load(); return () => { requestGeneration.current += 1 } }, [apiStatus, range])
  useEffect(() => {
    const date = new Date(selectedDate); date.setDate(date.getDate() + weekOffset * 7)
    setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1))
  }, [selectedDate, weekOffset])

  const openCreate = () => {
    setExternalEvent(null)
    const start = new Date(selectedDate)
    start.setDate(start.getDate() + weekOffset * 7)
    start.setHours(9, 0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    createBaseline.current = { startsAt: localInputDate(start), endsAt: localInputDate(end) }
    setStartsAt(localInputDate(start)); setEndsAt(localInputDate(end)); setRrule(''); setReminderAt(''); setMessage(''); setFormOpen(true)
    setEditing(null); setConfirmDelete(false); setTitle('')
    setReminders([]); operationKey.current = crypto.randomUUID()
  }

  const initialIntent = useRef(false)
  const pendingCreateIntent = useRef(false)
  const routeIntentHandler = useRef<() => void>(() => {})
  useEffect(() => {
    const readIntent = () => {
      if (window.location.pathname !== '/calendar' || new URLSearchParams(window.location.search).get('create') !== '1') return
      if (saving) { pendingCreateIntent.current = true; setMessage('The new event form will open after the current save.'); return }
      pendingCreateIntent.current = false
      if (editing) {
        setParkedEvent({ title, startsAt, endsAt, rrule, reminderAt, editing, reminders })
        openCreate()
      } else if (formOpen || createBaseline.current) {
        setFormOpen(true)
      } else openCreate()
    }
    routeIntentHandler.current = readIntent
    if (!initialIntent.current) { initialIntent.current = true; readIntent() }
    window.addEventListener('popstate', readIntent)
    return () => window.removeEventListener('popstate', readIntent)
  })

  useEffect(() => { if (!saving && pendingCreateIntent.current) routeIntentHandler.current() }, [saving])

  const resumeParkedEvent = () => {
    if (!parkedEvent) return
    const baseline = createBaseline.current
    if (!editing && (title.trim() || rrule.trim() || reminderAt || (baseline && (startsAt !== baseline.startsAt || endsAt !== baseline.endsAt)))) { setMessage('Save or clear the new event before resuming the event edit.'); return }
    setTitle(parkedEvent.title); setStartsAt(parkedEvent.startsAt); setEndsAt(parkedEvent.endsAt)
    setRrule(parkedEvent.rrule); setReminderAt(parkedEvent.reminderAt); setEditing(parkedEvent.editing)
    setReminders(parkedEvent.reminders); setParkedEvent(null); createBaseline.current = null; setFormOpen(true)
  }

  const editEvent = (occurrence: EventOccurrence) => {
    if (occurrence.external_source) { setExternalEvent(occurrence); setFormOpen(false); return }
    setExternalEvent(null)
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
      setTitle(''); createBaseline.current = null; setFormOpen(false); setMessage('Event saved.'); await load()
    } catch (error) {
      if (error instanceof ApiError) setMessage(`${error.code}: ${error.message}`)
      else setMessage('Could not save this event.')
    } finally { setSaving(false) }
  }

  const navigate = (direction: number) => {
    if (calendarView === 'week') { setWeekOffset(value => value + direction); return }
    const date = new Date(selectedDate); date.setDate(date.getDate() + weekOffset * 7)
    if (calendarView === 'month') { date.setDate(1); date.setMonth(date.getMonth() + direction) }
    else date.setDate(date.getDate() + direction)
    setSelectedDate(date); setWeekOffset(0)
  }
  const displayedDays = calendarView === 'day' ? [new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7)] : week
  const eventsByDay = new Map<string, readonly EventOccurrence[]>()
  for (const event of events) { const key = dayKey(event.starts_at); eventsByDay.set(key, [...(eventsByDay.get(key) ?? []), event]) }
  const weekScroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (status === 'ready' && weekScroll.current) weekScroll.current.scrollTop = 9 * HOUR_PX }, [status, weekOffset])
  const selectedDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7).toISOString()
  const nowDate = new Date()
  const nowInfo = { top: hourOf(nowDate.toISOString()) * HOUR_PX + GRID_PAD, label: `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}` }
  const zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zoneOffset = new Intl.DateTimeFormat(undefined, { timeZoneName: 'shortOffset' }).formatToParts(week[0]).find(part => part.type === 'timeZoneName')?.value ?? zoneName

  return { apiStatus, status, load, message, setMessage, saving, setSaving, formOpen, setFormOpen, title, setTitle, startsAt, setStartsAt, endsAt, setEndsAt, rrule, setRrule, reminderAt, setReminderAt, reminders, setReminders, editing, confirmDelete, externalEvent, setExternalEvent, parkedEvent, resumeParkedEvent, createEvent, deleteEvent, openCreate, editEvent, navigate, calendarView, setCalendarView, selectedDate, setSelectedDate, weekOffset, setWeekOffset, visibleMonth, showWeekends, setShowWeekends, assistantDraft, setAssistantDraft, week, range, displayedDays, eventsByDay, weekScroll, selectedDay, nowInfo, zoneName, zoneOffset }
}

export type CalendarHook = ReturnType<typeof useCalendar>
