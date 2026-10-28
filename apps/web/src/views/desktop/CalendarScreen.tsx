import { useState } from 'react'
import { CalendarSearch, ChevronLeft, ChevronRight, MapPin, Users, Video, type LucideIcon } from 'lucide-react'
import { ScreenToolbar } from '../../components/ScreenToolbar'
import { askAelys } from '../../lib/desktopStore'
import {
  CAL_MONTH_LABEL,
  CAL_RANGE,
  CAL_TZ,
  CAL_VIEWS,
  CAL_WEEK_LABEL,
  DOW,
  HOURS,
  MINI_MONTH,
  NOW_TOP,
  TODAY_EVENTS,
  WEEK,
  type CalTodayEvent,
} from '../../data/desktop/calendar'
import './calendar.css'

const PLACE_ICONS: Record<CalTodayEvent['placeIcon'], LucideIcon> = { video: Video, 'map-pin': MapPin }

export function CalendarScreen() {
  const [view, setView] = useState(1)
  // Day shows only today's column at full width; Month replaces the week grid with the month grid.
  const days = view === 0 ? WEEK.filter((day) => day.today) : WEEK
  const weekStyle = view === 0 ? { gridTemplateColumns: '64px minmax(0,1fr)' } : undefined
  const range = view === 0 ? { title: 'Wednesday, October 28, 2026', sub: CAL_WEEK_LABEL } : view === 2 ? { title: CAL_MONTH_LABEL, sub: '' } : { title: CAL_RANGE, sub: CAL_WEEK_LABEL }

  return (
    <>
      <ScreenToolbar
        placeholder="Ask Aelys to schedule something…"
        primary="Create event"
        onAsk={askAelys}
        secondary={[
          { label: 'Find a time', icon: CalendarSearch, color: '#6A4CF2' },
          { label: 'Invite people', icon: Users, color: '#2F6FE4' },
        ]}
      />
      <div className="calendar-layout">
        <div className="calendar-glass calendar-main">
          <div className="calendar-toolbar">
            <button type="button" className="calendar-btn">Today</button>
            <button type="button" className="calendar-btn calendar-btn--icon" title="Previous week" aria-label="Previous week">
              <ChevronLeft size={18} />
            </button>
            <button type="button" className="calendar-btn calendar-btn--icon" title="Next week" aria-label="Next week">
              <ChevronRight size={18} />
            </button>
            <div className="calendar-range">
              <div className="calendar-range__title">{range.title}</div>
              <div className="calendar-range__sub">{range.sub}</div>
            </div>
            <div className="calendar-views" role="tablist" aria-label="Calendar view">
              {CAL_VIEWS.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  role="tab"
                  aria-selected={i === view}
                  className={i === view ? 'calendar-views__tab calendar-views__tab--active' : 'calendar-views__tab'}
                  onClick={() => setView(i)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {view !== 2 && <div className="calendar-week" style={weekStyle}>
            <div className="calendar-gutter-head">{CAL_TZ}</div>
            {days.map((day) => (
              <div key={day.date} className="calendar-day-head" style={{ background: day.today ? 'rgba(106,76,242,.06)' : 'transparent' }}>
                <span className="calendar-day-name" style={{ color: day.today ? '#5132D6' : '#1C1B22' }}>{day.dn}</span>
                <span
                  className="calendar-day-date"
                  style={{ background: day.today ? '#6A4CF2' : 'transparent', color: day.today ? '#fff' : '#4F4A56' }}
                >
                  {day.date}
                </span>
              </div>
            ))}
          </div>}

          {view !== 2 && <div className="calendar-week calendar-week--body" style={weekStyle}>
            <div className="calendar-hours">
              {HOURS.map((h) => (
                <div key={h.t} className="calendar-hour" style={{ top: h.top }}>{h.t}</div>
              ))}
            </div>
            {days.map((day) => (
              <div key={day.date} className="calendar-column" style={{ background: day.today ? 'rgba(106,76,242,.06)' : 'transparent' }}>
                {day.today && (
                  <div className="calendar-now" style={{ top: NOW_TOP }}>
                    <span className="calendar-now__dot" />
                  </div>
                )}
                {day.events.map((e) => (
                  <button
                    key={e.t}
                    type="button"
                    className="calendar-event"
                    style={{ top: e.top, height: e.h, background: e.bg, borderLeft: `3px solid ${e.bd}` }}
                  >
                    <div className="calendar-event__title">{e.t}</div>
                    <div className="calendar-event__range">{e.r}</div>
                  </button>
                ))}
              </div>
            ))}
          </div>}

          {view === 2 && <div className="calendar-month">
            {DOW.map((d) => <div key={d} className="calendar-month__dow">{d}</div>)}
            {MINI_MONTH.map((m, i) => {
              const events = m.muted ? [] : (WEEK.find((day) => day.date === String(m.n))?.events ?? [])
              return <div key={i} className={m.muted ? 'calendar-month__cell calendar-month__cell--muted' : 'calendar-month__cell'} style={m.today ? { background: 'rgba(106,76,242,.06)' } : undefined}>
                <span className="calendar-month__num" style={m.today ? { background: '#6A4CF2', color: '#fff', fontWeight: 600 } : undefined}>{m.n}</span>
                {events.slice(0, 3).map((e) => <div key={e.t} className="calendar-month__event" style={{ background: e.bg, borderLeft: `3px solid ${e.bd}` }}>{e.t}</div>)}
              </div>
            })}
          </div>}
        </div>

        <div className="calendar-side">
          <div className="calendar-glass calendar-card">
            <div className="calendar-mini-head">
              <span className="calendar-mini-title">{CAL_MONTH_LABEL}</span>
              <button type="button" className="calendar-icon-btn" title="Previous month" aria-label="Previous month">
                <ChevronLeft size={16} />
              </button>
              <button type="button" className="calendar-icon-btn" title="Next month" aria-label="Next month">
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="calendar-mini-grid">
              {DOW.map((d) => (
                <span key={d} className="calendar-mini-dow">{d}</span>
              ))}
              {MINI_MONTH.map((m, i) => (
                <span
                  key={i}
                  className="calendar-mini-day"
                  style={{
                    background: m.today ? '#6A4CF2' : 'transparent',
                    color: m.today ? '#fff' : m.muted ? '#A29DA8' : '#1C1B22',
                    fontWeight: m.today ? 600 : 400,
                  }}
                >
                  {m.n}
                </span>
              ))}
            </div>
          </div>

          <div className="calendar-glass calendar-card calendar-card--grow">
            <div className="calendar-card__head">
              <span className="calendar-card__title">Today’s events</span>
              <span className="calendar-count">{TODAY_EVENTS.length}</span>
            </div>
            <div className="calendar-today-list">
              {TODAY_EVENTS.map((e) => {
                const PlaceIcon = PLACE_ICONS[e.placeIcon]
                return (
                  <div key={e.title} className="calendar-today-item" style={{ borderLeftColor: e.color }}>
                    <div className="calendar-today-item__range">{e.range}</div>
                    <div className="calendar-today-item__title">{e.title}</div>
                    <div className="calendar-today-item__foot">
                      <div className="calendar-avatars">
                        {e.people.map((c, i) => (
                          <span key={i} className="calendar-avatar" style={{ background: c }} />
                        ))}
                      </div>
                      <span className="calendar-place" style={{ color: e.placeColor, background: e.placeBg }}>
                        <PlaceIcon size={14} />
                        {e.place}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
