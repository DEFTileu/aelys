import { ApiError } from '@aelys/shared'
import { PageSkeleton } from '../../components/PageSkeleton'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import type { CalendarHook } from './useCalendar'

export function CalendarState({ status, retry }: { status: ApiStatus; retry: () => void }) {
  return <PageSkeleton kind="calendar" label="calendar" phase={status === 'loading' ? 'loading' : 'error'} onRetry={retry} />
}

export function EventForm({ t }: { t: CalendarHook }) {
  const { apiStatus, saving, setFormOpen, title, setTitle, startsAt, setStartsAt, endsAt, setEndsAt, rrule, setRrule, reminderAt, setReminderAt, editing, confirmDelete, createEvent, deleteEvent } = t
  return (
    <form aria-label="Event editor" className="cl-form" onSubmit={createEvent}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Event title" aria-label="New event title" /><label>Start<input required type="datetime-local" aria-label="Event start" value={startsAt} onInput={(event) => setStartsAt(event.currentTarget.value)} onChange={(event) => setStartsAt(event.target.value)} /></label><label>End<input required type="datetime-local" aria-label="Event end" value={endsAt} onInput={(event) => setEndsAt(event.currentTarget.value)} onChange={(event) => setEndsAt(event.target.value)} /></label>{editing?.rrule && <p>Editing the entire recurring series.</p>}<label>Repeat (RRULE)<input aria-label="Event recurrence" value={rrule} onChange={(event) => setRrule(event.target.value)} placeholder="FREQ=WEEKLY;COUNT=4" /></label><label>Reminder (same lead time on repeats)<input aria-label="Event reminder" type="datetime-local" value={reminderAt} onInput={(event) => setReminderAt(event.currentTarget.value)} onChange={(event) => setReminderAt(event.target.value)} /></label><button className="cl-btn cl-btn--primary" type="submit" disabled={saving || apiStatus !== 'ready'}>{saving ? 'Saving…' : 'Save'}</button><button className="cl-btn" type="button" disabled={saving} onClick={() => setFormOpen(false)}>Cancel</button>{editing && <button className="cl-btn" type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => void deleteEvent()}>{confirmDelete ? 'Confirm delete' : 'Delete event'}</button>}</form>
  )
}

export function EventReminders({ t }: { t: CalendarHook }) {
  const { apiStatus, setMessage, saving, setSaving, reminders, setReminders, editing } = t
  if (!editing) return null
  return (
    <section aria-label="Event reminders">{reminders.map((reminder) => <p key={reminder.id}>{new Date(reminder.notify_at).toLocaleString()} · {reminder.reminder_status} <button type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => { setSaving(true); void getSharedApiClient().cancelCalendarReminder(editing.id, reminder.id, reminder.version, { queueOnOffline: false }).then(async () => setReminders(await getSharedApiClient().calendarReminders(editing.id))).catch((error) => setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not cancel reminder.')).finally(() => setSaving(false)) }}>Cancel reminder</button></p>)}</section>
  )
}

export function ImportedEvent({ t }: { t: CalendarHook }) {
  const { externalEvent, setExternalEvent } = t
  if (!externalEvent) return null
  return (
    <section className="cl-form" aria-label="Imported event"><h3>{externalEvent.title}</h3><p>Read-only event from Google Calendar. Edit or delete it in Google Calendar.</p><p>{new Date(externalEvent.starts_at).toLocaleString()} — {new Date(externalEvent.ends_at).toLocaleString()}</p>{externalEvent.description && <p>{externalEvent.description}</p>}<button type="button" className="cl-btn" onClick={() => setExternalEvent(null)}>Close</button></section>
  )
}

export function CalendarAlerts({ t }: { t: CalendarHook }) {
  const { apiStatus, message, parkedEvent, resumeParkedEvent } = t
  return <>
    {parkedEvent && <p role="status">Event edit kept. <button type="button" onClick={resumeParkedEvent}>Resume event edit</button></p>}
    {apiStatus !== 'ready' && <p role="status">Calendar is offline or unavailable. Previously loaded events may be shown from cache. Changes require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}
    {message && <p className="cl-message" role="status">{message}</p>}
  </>
}
