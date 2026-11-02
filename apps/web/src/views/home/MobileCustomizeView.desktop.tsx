import { useState } from 'react'
import { useWindowWidth } from '../../lib/desktopStore'
import { navigate } from '../../lib/router'
import { AddWidgetSheet } from '../desktop/AddWidgetSheet'
import { layoutKey, newLayoutEntry, pendingHighlight, readLayout, saveLayout } from '../desktop/homeLayout'

/** The /widgets route is the Add widget sheet; arranging cards happens on Home itself. */
export function CustomizeDesktop() {
  const mobile = useWindowWidth() <= 700
  const [layout] = useState(() => readLayout(mobile))
  const [notice, setNotice] = useState('')
  const home = () => navigate('/')
  return <>
    {notice && <p role="status" className="add-widget-notice">{notice}</p>}
    <AddWidgetSheet fullScreen layout={layout} onClose={home} onAdd={(id, size) => {
      const entry = newLayoutEntry(id, size, layout)
      if (!saveLayout([...layout, entry], mobile)) { setNotice('Could not save. Allow local storage and try again.'); return }
      pendingHighlight.key = layoutKey(entry)
      home()
    }} />
  </>
}
