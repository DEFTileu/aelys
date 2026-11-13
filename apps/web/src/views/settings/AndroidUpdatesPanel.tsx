import { checkAndroidUpdates, installAndroidUpdate, isAndroidUpdateHost, useAndroidUpdates } from '../../lib/androidUpdates'

export function AndroidUpdatesPanel() {
  const update = useAndroidUpdates()
  if (!isAndroidUpdateHost() || !update.supported) return null
  const progress = update.progress && update.progress.total > 0 ? ` ${Math.min(100, Math.floor(update.progress.downloaded / update.progress.total * 100))}%` : ''
  return <div className="st-pad">
    {update.currentVersion && <div className="st-hint">Current version: {update.currentVersion}</div>}
    {update.checked && !update.update && <div className="st-hint" role="status">Aelys is up to date.</div>}
    {update.update && <div className="st-label">Available version: {update.update.version}</div>}
    {update.error && <div className="st-msg" role="status">{update.error}</div>}
    {update.installerOpened && <div className="st-msg" role="status">Android installer opened. Complete installation there.</div>}
    <div className="st-row st-row--wrap">
      <button type="button" className="st-btn" disabled={!!update.busy} onClick={() => void checkAndroidUpdates(true)}>{update.busy === 'checking' ? 'Checking…' : 'Check for updates'}</button>
      {update.update && <button type="button" className="st-btn" disabled={!!update.busy} onClick={() => void installAndroidUpdate()}>{update.busy === 'downloading' ? `Downloading${progress}` : update.busy === 'installing' ? 'Opening installer…' : update.error ? 'Retry' : 'Update'}</button>}
    </div>
  </div>
}
