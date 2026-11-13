import { useEffect, useRef } from 'react'
import { Lock } from '../../../icons'

/** "Confirm it's you" sheet over the lost-mode page; the fingerprint itself is asked by the native host while this is open. */
export function ReauthSheet({ error, onCancel }: { error: string; onCancel: () => void }) {
  const sheet = useRef<HTMLDivElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  // Focus moves into the sheet, Escape is Cancel, and focus goes back to the button that opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    sheet.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel.current() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus() }
  }, [])
  return <div className="dv-dim">
    <div className="dv-sheet" role="dialog" aria-modal="true" aria-labelledby="dv-reauth-title" tabIndex={-1} ref={sheet}>
      <div className="dv-grab" />
      <div className="dv-sheet-head">
        <span className="dv-fp"><Lock size={30} aria-hidden="true" /></span>
        <div className="dv-sheet-title" id="dv-reauth-title">Confirm it's you</div>
        <div className="st-hint">Turning off lost mode shows your tasks and notifications on Aelys again</div>
      </div>
      {error && <div className="st-error" role="alert">{error}</div>}
      <button type="button" className="st-btn st-btn--ghost dv-wide" onClick={onCancel}>Cancel</button>
    </div>
  </div>
}
