import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { TasksDesktop } from './tasks/TasksView.desktop'
import { TasksMobile } from './tasks/TasksView.mobile'
import './desktop/page-tokens.css'
import './desktop/tasks.css'

export function TasksView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <TasksMobile apiStatus={apiStatus} /> : <TasksDesktop apiStatus={apiStatus} />
}
