import { useProtectionProblem } from '../lib/focusHandoff'
import { navigate } from '../lib/router'
import '../views/settings/settings.css'

/** App-wide warning that app limits are not enforced on this phone (Android, after limits were configured). */
export function ProtectionNotice() {
  const { problem, dismiss } = useProtectionProblem()
  if (!problem) return null
  return <aside className="st-banner st-banner--bad" role="alert" aria-label="App limits protection" style={{ '--st-field': 'var(--surface, #F7F4F1)' } as React.CSSProperties}>
    <b>{problem === 'off' ? 'Protection is off: limited apps are not blocked' : 'Aelys cannot confirm that limits are working'}</b>
    <button type="button" className="st-btn" onClick={() => navigate('/app-limits')}>Open App limits</button>
    <button type="button" className="st-btn" onClick={dismiss}>Dismiss</button>
  </aside>
}
