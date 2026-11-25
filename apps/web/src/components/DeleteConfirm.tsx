import { useEffect, useRef } from 'react'
import './delete-confirm.css'

type Props = { kind: 'project' | 'note'; name: string; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }

export function DeleteConfirm({ kind, name, busy, error, onCancel, onConfirm }: Props) {
  const cancel = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancel.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="delete-confirm-overlay">
    <section ref={panel} className="delete-confirm" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel() }
      if (event.key === 'Tab') {
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        if (!buttons.length) { event.preventDefault(); return }
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (event.shiftKey && index <= 0) { event.preventDefault(); buttons[buttons.length - 1]?.focus() }
        else if (!event.shiftKey && (index === -1 || index === buttons.length - 1)) { event.preventDefault(); buttons[0]?.focus() }
      }
    }}>
      <h2 id="delete-confirm-title">Delete {kind}?</h2>
      <p id="delete-confirm-description">Delete {name}?{kind === 'note' && ' Unsaved changes to this note will be lost.'}</p>
      {error && <p role="alert">{error}</p>}
      <div className="delete-confirm__actions"><button ref={cancel} type="button" className="pn-button" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="pn-button delete-confirm__delete" disabled={busy} onClick={onConfirm}>{busy ? 'Deleting…' : 'Delete'}</button></div>
    </section>
  </div>
}
