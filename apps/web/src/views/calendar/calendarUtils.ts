export const HOURS = Array.from({ length: 24 }, (_, index) => index)
export const HOUR_PX = 50
export const GRID_PAD = 10
// Event tints from the design (soft fill, strong edge), picked by a stable hash of the event id.
export const TINTS = [['#E4EEFD', '#4A8EF0', 'rgba(74,142,240,.20)'], ['#EEE8FD', '#8B6CF0', 'rgba(139,108,240,.22)'], ['#FDE6E1', '#F07362', 'rgba(240,115,98,.18)'], ['#DCF5EC', '#36BE8A', 'rgba(54,190,138,.18)'], ['#FDF1D9', '#EFB23E', 'rgba(239,178,62,.18)']] as const
export const tintFor = (id: string) => TINTS[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TINTS.length]
export const hourOf = (value: string) => { const date = new Date(value); return date.getHours() + date.getMinutes() / 60 }
export const dayKey = (value: string) => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

// ISO 8601 week number: the week containing the Thursday decides the year.
export function isoWeek(value: Date): number {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  return Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
}
export function monthLabel(value: Date) { return value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }
export function localInputDate(value: Date) { return `${dayKey(value.toISOString())}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}` }
