// Card bodies are drawn by desktopBodies.tsx on every width; the mobile shell only changes their metrics in CSS.
import type { TaskOut } from '@aelys/shared'
import type { SizeKey, WidgetId } from './homeLayout'
import type { FocusTimer, HomeData } from './homeWidgets'
import { DesktopBody } from './desktopBodies'

export const isDone = (task: TaskOut) => ['done', 'completed', 'complete', 'closed', 'cancelled'].includes(task.status.toLowerCase())

export type BodyProps = {
  id: WidgetId; size: SizeKey; mobile: boolean; focus: FocusTimer; data: HomeData
  onToggleTask: (task: TaskOut) => void; onAddTask: (title: string) => Promise<boolean>
}

export function WidgetBody(props: BodyProps & { onRetry: () => void }) {
  const { id, data, onRetry } = props
  const state = data.states?.[id]
  if (state === 'loading') return <div className="dw-empty"><span>Loading…</span></div>
  if (state && state !== 'ready') return <div className="dw-empty"><span>Can’t load</span><button type="button" className="home-btn dw-action" onClick={onRetry}>Retry</button></div>
  return <DesktopBody {...props} />
}
