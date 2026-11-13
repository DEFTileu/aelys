import { useEffect } from 'react'
import { checkAndroidUpdates, dismissAndroidUpdateNotice, installAndroidUpdate, isAndroidUpdateHost, useAndroidUpdates } from '../lib/androidUpdates'
import '../views/settings/settings.css'

export function AndroidUpdateNotice() {
  const update = useAndroidUpdates()
  useEffect(() => { void checkAndroidUpdates() }, [])
  if (!isAndroidUpdateHost() || !update.supported || !update.update || update.dismissed) return null
  const progress = update.progress && update.progress.total > 0 ? ` ${Math.min(100, Math.floor(update.progress.downloaded / update.progress.total * 100))}%` : ''
  return <aside className="st-banner" style={{ background: 'var(--st-green-bg, #DCF5EC)', color: 'var(--st-green-ink, #0E7A57)', '--st-field': 'var(--surface, #F7F4F1)' } as React.CSSProperties} aria-label="Android update">
    <b>Aelys {update.update.version} is available</b>
    {update.error && <span role="status">{update.error}</span>}
    {update.installerOpened && <span role="status">Android installer opened. Complete installation there.</span>}
    <button type="button" className="st-btn" disabled={!!update.busy} onClick={() => void installAndroidUpdate()}>{update.busy === 'downloading' ? `Downloading${progress}` : update.busy === 'installing' ? 'Opening installer…' : update.error ? 'Retry' : 'Update'}</button>
    <button type="button" className="st-btn" onClick={dismissAndroidUpdateNotice}>Dismiss</button>
  </aside>
}
