import { PageSkeleton } from '../../components/PageSkeleton'
import { ArrowRight, Check, LayoutGrid, Plus, RotateCcw } from '../../icons'
import { AddWidgetSheet } from '../desktop/AddWidgetSheet'
import { HOME_CHIPS } from '../../data/desktop/home'
import { askAelys } from '../../lib/desktopStore'
import { formatDate, greetingForHour } from '../../lib/format'
import { useOwner } from '../../lib/owner'
import { usePrefs } from '../../lib/prefs'
import { useWeather } from '../../lib/weather'
import type { ApiStatus } from '../../types'
import { WIDGET_CATALOG, layoutKey, reorderLayout } from '../desktop/homeLayout'
import { RecentActivity } from '../desktop/RecentActivity'
import { WeatherIcon, degrees } from '../desktop/desktopBodies'
import { HomeWidget } from '../desktop/homeWidgets'
import { ORB, useHome } from './useHome'

/** Phone Home greeting: date, hello line, quote and the weather chip, drawn over the wallpaper. */
function MobileGreeting({ apiStatus }: { apiStatus: ApiStatus }) {
  const owner = useOwner(apiStatus)
  const { greeting } = usePrefs()
  const { forecast } = useWeather()
  const now = new Date()
  return <section className="home-greeting" aria-label="Greeting">
    <div className="home-greeting__date">{formatDate(now)}</div>
    <h1>{greeting === 'hello' ? 'Hello' : greetingForHour(now.getHours())},<br />{owner.name ?? 'there'}</h1>
    <div className="home-greeting__row"><div>A calm day creates bigger results.</div>{forecast && <div className="home-greeting__weather"><WeatherIcon code={forecast.code} day={forecast.isDay} size={18} />{degrees(forecast.temperature)}</div>}</div>
  </section>
}

export function HomeMobile({ apiStatus }: { apiStatus?: ApiStatus }) {
  const { layout, editing, setEditing, grid, layoutToolbar, sheet, setSheet, homeToggles, draft, setDraft, taskNotice, layoutNotice, data, setReload, focus, ask, toggleTask, addTask, commit, addWidget, moveWidget, sizeWidget, removeWidget, resetLayout } = useHome(apiStatus, true)
  return <div className={`home-screen${editing ? ' home-screen--editing' : ''}`} style={{ padding: '0 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
    {homeToggles[0] && <MobileGreeting apiStatus={apiStatus ?? 'loading'} />}
    {homeToggles[2] && <section aria-label="Ask Aelys" data-glass="" style={{ padding: 16, borderRadius: 24, background: 'var(--dw-section, rgba(255,255,255,.72))', backdropFilter: 'blur(20px)', border: '1px solid var(--dw-edge, rgba(255,255,255,.35))', boxShadow: '0 8px 28px rgba(40,30,30,.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div aria-hidden="true" style={{ width: 48, height: 48, flex: 'none', borderRadius: '50%', background: ORB, boxShadow: '0 0 20px rgba(130,100,255,.5)' }} />
        <label className="home-composer" style={{ flex: 1, height: 56, borderRadius: 28, background: 'var(--dw-btn, #fff)', display: 'flex', alignItems: 'center', padding: '0 8px 0 20px', boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
          <input className="home-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') ask(draft) }} placeholder="Ask Aelys or take an action…" aria-label="Ask Aelys or take an action" style={{ flex: 1, fontSize: 16, lineHeight: '24px' }} />
          <button type="button" className="home-btn home-send" onClick={() => ask(draft)} aria-label="Send" title="Send" style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ArrowRight size={18} aria-hidden="true" /></button>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {HOME_CHIPS.map((chip) => <button key={chip.label} type="button" className="home-btn home-chip" onClick={() => askAelys(chip.label)}><chip.icon size={16} style={{ color: chip.color }} aria-hidden="true" />{chip.label}</button>)}
      </div>
    </section>}

    {editing && <div ref={layoutToolbar} className="home-layout-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 22, lineHeight: '30px', fontWeight: 600 }}>My day</h2>
      </div>
      {editing
? <>
          <button type="button" className="home-btn home-tool" aria-label="Reset layout" title="Reset to default layout" onClick={resetLayout}><RotateCcw size={16} aria-hidden="true" /></button>
          <button type="button" className="home-btn home-tool home-done" onClick={() => { setEditing(false); setSheet(false) }} style={{ padding: '0 16px', fontSize: 14 }}><Check size={18} aria-hidden="true" />Done</button>
          <button type="button" className="home-btn home-add" aria-haspopup="dialog" aria-label="Add widget" onClick={() => setSheet(true)}><Plus size={18} aria-hidden="true" />Widget</button>
        </>
        : <button type="button" className="home-btn home-tool" onClick={() => setEditing(true)}><LayoutGrid size={16} aria-hidden="true" />Customize</button>}
    </div>}

    {apiStatus === 'loading' && <PageSkeleton kind="home" label="workspace" />}
    {apiStatus !== 'ready' && apiStatus !== 'loading' && <p role="status">{'Workspace offline or unavailable. Showing cached records where available; changes require a connection (OFFLINE_WRITE_UNAVAILABLE).'}</p>}
    {taskNotice && <p role="status">{taskNotice}</p>}
    {layoutNotice && <p role="status">{layoutNotice}</p>}
    {editing && <p className="home-layout-help">Drag a card to move it, drag its corner to resize to S, M, L or Tall.</p>}
    {homeToggles[1] && <section ref={grid} aria-label="Dashboard widgets" className={`home-widget-grid${editing ? ' home-widget-grid--editing' : ''}`}>
      {layout.map((entry) => {
        const [id, span, height] = entry
        const key = layoutKey(entry)
        return <HomeWidget key={key} id={id} editing={editing} mobile focus={focus} data={data} onToggleTask={(task) => void toggleTask(task)} onAddTask={addTask} onRetry={() => setReload((value) => value + 1)} onRemove={() => removeWidget(key)} onLongPress={() => setEditing(true)} frame={{ id, itemKey: key, title: WIDGET_CATALOG[id].title, span, height, onDrop: (source, target) => commit(reorderLayout(layout, source, target)), onMove: (delta) => moveWidget(key, delta), onSize: (width, nextHeight) => sizeWidget(key, width, nextHeight) }} />
      })}
    </section>}
    {!editing && <button type="button" className="home-btn home-customize" onClick={() => setEditing(true)}><LayoutGrid size={18} aria-hidden="true" />Customize home</button>}
    {homeToggles[3] && <RecentActivity items={data.activity ?? []} state={data.states?.activity} />}
    <div style={{ height: 12 }} />
    {sheet && <AddWidgetSheet layout={layout} onAdd={addWidget} onClose={() => setSheet(false)} />}
  </div>
}
