import { useEffect, useId, useRef, useState } from 'react'
import './feedback-examples.css'

export function FeedbackExamples() {
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputId = useId()
  const titleId = useId()
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [toast, setToast] = useState(false)

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  function showToast() {
    clearTimeout(toastTimer.current)
    setToast(true)
    toastTimer.current = setTimeout(() => setToast(false), 4500)
  }

  function dismissToast() {
    clearTimeout(toastTimer.current)
    setToast(false)
  }

  return (
    <div className="feedback-examples">
      <div className="feedback-actions">
        <button ref={opener} className="button button--quiet" type="button" onClick={() => { dialog.current?.showModal(); dialog.current?.querySelector('input')?.focus() }}>Открыть диалог</button>
        <button className="button button--quiet" type="button" onClick={showToast}>Показать уведомление</button>
      </div>
      <div className="feedback-status" role="status">{saved ? 'Пример обновлён' : ''}</div>
      {toast && <div className="feedback-toast" role="status"><span>Пример уведомления</span><button type="button" onClick={dismissToast} aria-label="Закрыть уведомление">×</button></div>}
      <div className="feedback-disclosures">
        <details><summary>Что показывает этот пример?</summary><p>Диалог и уведомление работают только в этой галерее.</p></details>
        <details><summary>Как закрыть диалог?</summary><p>Нажмите Escape или используйте кнопку закрытия.</p></details>
      </div>
      <dialog ref={dialog} className="feedback-dialog" aria-labelledby={titleId} onClose={() => opener.current?.focus()}>
        <form onSubmit={(event) => { event.preventDefault(); setSaved(true); dialog.current?.close() }}>
          <div className="feedback-dialog-heading"><h3 id={titleId}>Пример диалога</h3><button type="button" onClick={() => dialog.current?.close()} aria-label="Закрыть диалог">×</button></div>
          <label htmlFor={inputId}>Название проекта</label>
          <input id={inputId} value={name} onChange={(event) => setName(event.target.value)} />
          <div className="feedback-dialog-actions"><button className="button button--quiet" type="button" onClick={() => dialog.current?.close()}>Отмена</button><button className="button button--primary" type="submit">Сохранить</button></div>
        </form>
      </dialog>
    </div>
  )
}

export function MotionExamples() {
  const [replay, setReplay] = useState(0)
  const [pending, setPending] = useState(false)
  const [complete, setComplete] = useState(false)
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(loadingTimer.current), [])

  function startLoading() {
    clearTimeout(loadingTimer.current)
    setComplete(false)
    setPending(true)
    loadingTimer.current = setTimeout(() => { setPending(false); setComplete(true) }, 1000)
  }

  return (
    <div className="motion-examples">
      <div className="motion-controls"><button className="button button--quiet motion-preview" type="button" onClick={() => setReplay((value) => value + 1)}>Повторить анимацию</button><button className="button button--quiet motion-preview" type="button" onClick={startLoading} disabled={pending}>{pending ? 'Выполняется пример…' : 'Запустить пример'}</button></div>
      <div key={replay} className={replay ? 'motion-card motion-card--enter' : 'motion-card'}><strong>Карточка примера</strong><span>Появление за 500 мс</span></div>
      {pending && <div className="motion-skeleton" aria-hidden="true"><span /><span /></div>}
      <div className="motion-status" role="status">{pending ? 'Пример выполняется…' : complete ? 'Пример завершён' : ''}</div>
    </div>
  )
}
