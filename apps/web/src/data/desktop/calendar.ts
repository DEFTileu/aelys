// Demo data for the Calendar screen, mirrored from the Aelys Desktop design script.

export type CalTint = 'blue' | 'violet' | 'coral' | 'green' | 'yellow'

// Week grid runs 09:00 to 21:00 at 50px per hour; 10px top offset, 4px shorter than the slot.
export const HOUR_PX = 50

const TINTS: Record<CalTint, [bg: string, border: string]> = {
  blue: ['#E4EEFD', '#4A8EF0'],
  violet: ['#EEE8FD', '#8B6CF0'],
  coral: ['#FDE6E1', '#F07362'],
  green: ['#DCF5EC', '#36BE8A'],
  yellow: ['#FDF1D9', '#EFB23E'],
}

export type CalEvent = { t: string; r: string; top: number; h: number; bg: string; bd: string }

export function calEvent(t: string, start: string, end: string, tint: CalTint): CalEvent {
  const [bg, bd] = TINTS[tint]
  const hours = (x: string) => {
    const [h, m] = x.split(':').map(Number)
    return h + m / 60
  }
  return {
    t,
    r: `${start} – ${end}`,
    top: (hours(start) - 9) * HOUR_PX + 10,
    h: (hours(end) - hours(start)) * HOUR_PX - 4,
    bg,
    bd,
  }
}

export type CalDay = { dn: string; date: string; today: boolean; events: CalEvent[] }

export const WEEK: CalDay[] = [
  {
    dn: 'Mon', date: '26', today: false,
    events: [calEvent('Team call', '10:00', '11:00', 'blue'), calEvent('API review', '13:00', '14:00', 'violet'), calEvent('Release plan', '16:00', '17:00', 'violet'), calEvent('Workout', '18:00', '19:00', 'green')],
  },
  {
    dn: 'Tue', date: '27', today: false,
    events: [calEvent('Sync', '09:30', '10:30', 'coral'), calEvent('Design review', '12:00', '13:00', 'yellow'), calEvent('Client meeting', '15:00', '16:00', 'blue'), calEvent('Books', '19:00', '20:00', 'violet')],
  },
  {
    dn: 'Wed', date: '28', today: true,
    events: [calEvent('Team call', '10:00', '11:00', 'blue'), calEvent('API review', '12:00', '13:00', 'violet'), calEvent('Gym', '15:00', '16:00', 'coral'), calEvent('Workout', '18:00', '19:00', 'green')],
  },
  {
    dn: 'Thu', date: '29', today: false,
    events: [calEvent('Project work', '11:00', '12:30', 'blue'), calEvent('Lecture notes', '14:00', '15:00', 'yellow'), calEvent('Mentor call', '17:00', '18:00', 'blue')],
  },
  {
    dn: 'Fri', date: '30', today: false,
    events: [calEvent('Presentation', '10:00', '11:00', 'violet'), calEvent('Team lunch', '13:00', '14:00', 'green'), calEvent('Inbox cleanup', '16:00', '17:00', 'coral'), calEvent('Side project', '19:00', '20:00', 'violet')],
  },
]

export const HOURS = Array.from({ length: 13 }, (_, i) => ({ t: `${String(9 + i).padStart(2, '0')}:00`, top: i * HOUR_PX + 2 }))

// Current-time indicator position (about 09:40 on the grid).
export const NOW_TOP = 0.67 * HOUR_PX + 10

export const CAL_VIEWS = ['Day', 'Week', 'Month'] as const
export const CAL_TZ = 'GMT+6'
export const CAL_RANGE = 'October 26 – 30, 2026'
export const CAL_WEEK_LABEL = 'Week 44'
export const CAL_MONTH_LABEL = 'October 2026'
export const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

// Previous month's trailing days, October 1 to 31 (today is the 28th), then the next month's first day.
export const MINI_MONTH: { n: number; muted: boolean; today: boolean }[] = [
  ...[28, 29, 30].map((n) => ({ n, muted: true, today: false })),
  ...Array.from({ length: 31 }, (_, i) => ({ n: i + 1, muted: false, today: i + 1 === 28 })),
  { n: 1, muted: true, today: false },
]

export type CalTodayEvent = {
  range: string
  title: string
  color: string
  people: string[]
  place: string
  placeIcon: 'video' | 'map-pin'
  placeColor: string
  placeBg: string
}

export const TODAY_EVENTS: CalTodayEvent[] = [
  { range: '10:00 – 11:00', title: 'Team call', color: '#4A8EF0', people: ['#C9A68A', '#8C7B6E', '#B5917A'], place: 'Join', placeIcon: 'video', placeColor: '#5132D6', placeBg: '#EEEAFD' },
  { range: '12:00 – 13:00', title: 'API review', color: '#8B6CF0', people: ['#A88A78', '#6E5A50'], place: 'Meeting room A', placeIcon: 'map-pin', placeColor: '#4F4A56', placeBg: 'transparent' },
  { range: '15:00 – 16:00', title: 'Gym', color: '#F07362', people: [], place: 'Fitness House', placeIcon: 'map-pin', placeColor: '#4F4A56', placeBg: 'transparent' },
  { range: '18:00 – 19:00', title: 'Workout', color: '#36BE8A', people: [], place: 'Medeu Stadium', placeIcon: 'map-pin', placeColor: '#4F4A56', placeBg: 'transparent' },
]
