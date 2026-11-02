import { ChevronLeft, ChevronRight, Plus } from '../../icons'
import type { ApiStatus } from '../../types'
import '../actual-calendar.css'
import './calendar-mobile.css'
import { CalendarAlerts, CalendarState, EventForm, EventReminders, ImportedEvent } from './CalendarShared'
import { dayKey, formatTime, monthLabel } from './calendarUtils'
import { useCalendar } from './useCalendar'

// Week strip and the selected day's agenda; no hour grid. Event editing opens in a bottom sheet.
export function CalendarMobile({ apiStatus: initialStatus }: { apiStatus: ApiStatus }) {
  const t = useCalendar(initialStatus)
  const { week, selectedDate, weekOffset, setSelectedDate, setWeekOffset, navigate, eventsByDay, status, load, openCreate, editEvent, formOpen, setFormOpen, editing, externalEvent, setExternalEvent } = t
  const selectedDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + weekOffset * 7)
  const selectedKey = dayKey(selectedDay.toISOString())
  const todayKey = dayKey(new Date().toISOString())
  const dayEvents = eventsByDay.get(selectedKey) ?? []
  const sheetOpen = formOpen || externalEvent !== null
  const closeSheet = () => { if (externalEvent) setExternalEvent(null); else setFormOpen(false) }

  return <div className="calendar-m">
    <CalendarAlerts t={t} />
    <header className="calendar-m-head">
      <h1>Calendar</h1>
      <div className="calendar-m-nav">
        <button type="button" aria-label="Previous week" onClick={() => navigate(-1)}><ChevronLeft size={18} /></button>
        <span>{monthLabel(week[0])}</span>
        <button type="button" aria-label="Next week" onClick={() => navigate(1)}><ChevronRight size={18} /></button>
      </div>
    </header>
    {status !== 'ready' ? <CalendarState status={status} retry={() => void load()} /> : <>
      <div className="calendar-m-strip" role="group" aria-label="Week">
        {week.map((day) => {
          const key = dayKey(day.toISOString())
          return <button type="button" key={key} aria-pressed={key === selectedKey} aria-label={day.toDateString()} className={key === todayKey ? 'calendar-m-today' : undefined} onClick={() => { setSelectedDate(day); setWeekOffset(0) }}>
            <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <b>{day.getDate()}</b>
            {(eventsByDay.get(key)?.length ?? 0) > 0 && <i aria-hidden="true" />}
          </button>
        })}
      </div>
      <section className="calendar-m-agenda" aria-label="Agenda">
        <h2>{selectedDay.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
        {dayEvents.length === 0 && <p className="calendar-m-empty">No events on this day.</p>}
        <ul>{dayEvents.map((event) => <li key={event.occurrence_id}>
          <button type="button" className="calendar-m-event" onClick={() => editEvent(event)}>
            <time>{formatTime(event.starts_at)} – {formatTime(event.ends_at)}</time>
            <strong>{event.title}</strong>
          </button>
        </li>)}</ul>
      </section>
      <button type="button" className="calendar-m-fab" aria-label="Create event" onClick={openCreate}><Plus size={24} /></button>
    </>}
    {sheetOpen && <div className="calendar-m-sheet-layer">
      <div className="calendar-m-scrim" aria-hidden="true" onClick={closeSheet} />
      <section className="calendar-m-sheet" role="dialog" aria-modal="true" aria-label={externalEvent ? 'Imported event' : editing ? 'Edit event' : 'New event'}>
        {externalEvent ? <ImportedEvent t={t} /> : <><EventForm t={t} />{editing && <EventReminders t={t} />}</>}
      </section>
    </div>}
  </div>
}
