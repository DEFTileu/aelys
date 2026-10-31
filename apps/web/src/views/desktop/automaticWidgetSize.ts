import { normalizeWidgetSize, WIDGET_GRID_GAP, WIDGET_GRID_ROW, type WidgetId } from './homeLayout'
import type { HomeData } from './homeWidgets'

export function widgetColumns(width: number, mobile: boolean): number {
  return mobile ? width >= 308 ? 2 : 1 : Math.max(1, Math.min(4, Math.floor((width + WIDGET_GRID_GAP) / (248 + WIDGET_GRID_GAP))))
}

/** Bounded summaries grow with records; empty/error cards never reserve tall space. */
export function automaticWidgetSize(id: WidgetId, width: number, mobile: boolean, data: HomeData, forecast = false) {
  const columns = widgetColumns(width, mobile)
  const columnWidth = (width - WIDGET_GRID_GAP * (columns - 1)) / columns
  const counts: Record<WidgetId, number> = { today: data.tasks.length, cal: data.events.length, proj: data.projects.length, notes: data.notes.length, kb: data.notes.length, fin: data.finance.length, mail: data.mail?.length ?? 0, activity: data.activity?.length ?? 0, focus: 0, weather: 0 }
  const count = data.states?.[id] && data.states[id] !== 'ready' ? 0 : counts[id]
  const needsControlSpace = (id === 'focus' || id === 'weather') && columnWidth < 280
  const needsRecordSpace = count > 0 && (columnWidth < 280 || id === 'today' || id === 'cal') || count > 2
  const wide = columns > 1 && (needsControlSpace || needsRecordSpace)
  const span = wide ? 2 : 1
  const rows = id === 'weather' ? forecast ? 2 : 1 : count > 6 ? 3 : count > 2 ? 2 : 1
  return normalizeWidgetSize(span, rows * (WIDGET_GRID_ROW + WIDGET_GRID_GAP) - WIDGET_GRID_GAP)
}
