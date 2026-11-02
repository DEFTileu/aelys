import { PageSkeleton } from '../../components/PageSkeleton'
import { LayoutGrid } from '../../icons'
import { navigate } from '../../lib/router'
import type { ApiStatus } from '../../types'
import { WIDGET_CATALOG, layoutKey } from '../desktop/homeLayout'
import { HomeWidget } from '../desktop/homeWidgets'
import { useHome } from './useHome'
import './home-mobile.css'

// The shell already provides the header, Ask bar and chips; cards are read-only here and long-press opens Customize.
const noop = () => {}

export function HomeMobile({ apiStatus }: { apiStatus?: ApiStatus }) {
  const { visibleLayout, homeToggles, taskNotice, data, retry, focus, toggleTask, addTask } = useHome(apiStatus, true)

  return <div className="home-screen home-m">
    <h2 className="home-m__title">My day</h2>
    {apiStatus === 'loading' && <PageSkeleton kind="home" label="workspace" />}
    {apiStatus !== 'ready' && apiStatus !== 'loading' && <p role="status">{'Workspace offline or unavailable. Showing cached records where available; changes require a connection (OFFLINE_WRITE_UNAVAILABLE).'}</p>}
    {taskNotice && <p role="status">{taskNotice}</p>}
    {homeToggles[1] && <section aria-label="Dashboard widgets" className="home-widget-grid">
      {visibleLayout.map((entry) => {
        const [id, span, height] = entry
        const key = layoutKey(entry)
        return <HomeWidget key={key} id={id} editing={false} mobile focus={focus} data={data} onToggleTask={(task) => void toggleTask(task)} onAddTask={addTask} onRetry={retry} onRemove={noop} onLongPress={() => navigate('/widgets')} frame={{ id, itemKey: key, title: WIDGET_CATALOG[id].title, span, height, onDrop: noop, onMove: noop, onSize: noop }} />
      })}
    </section>}
    <button type="button" className="home-m__customize" onClick={() => navigate('/widgets')}><LayoutGrid size={16} aria-hidden="true" />Customize home</button>
  </div>
}
