import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { diagnostics } from '../lib/diagnostics'
import { AelysMark } from './AelysMark'
import './developer-tools.css'

export function DeveloperLogo({ size = 40 }: { size?: number }) {
  const [open, setOpen] = useState(false)
  const [pulse, setPulse] = useState(0)
  const taps = useRef<number[]>([])
  const close = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const state = useSyncExternalStore(diagnostics.subscribe, diagnostics.getSnapshot, diagnostics.getSnapshot)
  useEffect(() => {
    if (!open) return
    close.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      if (event.key === 'Tab') {
        const dialog = close.current?.closest('[role=dialog]')
        const controls = dialog?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!controls?.length) return
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus() }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); trigger.current?.focus() }
  }, [open])
  const press = () => {
    setPulse(value => value + 1)
    const now = Date.now()
    taps.current = [...taps.current.filter(time => now - time < 12000), now]
    if (taps.current.length >= 10) { taps.current = []; setOpen(true) }
  }
  return <>
    <button ref={trigger} type="button" className="developer-logo" aria-label="Aelys" onClick={press}><span key={pulse} className={pulse ? 'developer-logo__pulse' : undefined}><AelysMark size={size} /></span></button>
    {open && createPortal(<div className="dev-overlay"><div className="dev-overlay__backdrop" onClick={() => setOpen(false)} aria-hidden="true" /><section className="dev-panel" role="dialog" aria-modal="true" aria-labelledby="dev-title">
      <header className="dev-panel__head"><div><small>AELYS · LOCAL</small><h2 id="dev-title">Инструменты разработчика</h2><p>Диагностика текущего устройства</p></div><button ref={close} type="button" onClick={() => setOpen(false)} aria-label="Закрыть">✕</button></header>
      <div className="dev-panel__body"><div className="dev-panel__setting"><div><strong>Записывать AI-запросы</strong><p>Только создание запуска. Данные хранятся в памяти и удаляются при выключении.</p></div><button type="button" role="switch" aria-checked={state.enabled} className={`dev-switch${state.enabled ? ' dev-switch--on' : ''}`} onClick={() => diagnostics.setEnabled(!state.enabled)}><span /></button></div>
      <p className="dev-panel__privacy">Тексты, идентификаторы и секреты скрыты. Для ответа сервера показаны HTTP-статус и стоимость; это не полный сетевой журнал.</p>
      <div className="dev-panel__section"><h3>Запросы <span>{state.entries.length}</span></h3><button type="button" onClick={diagnostics.clear} disabled={!state.entries.length}>Очистить</button></div>
      {!state.entries.length ? <div className="dev-panel__empty">{state.enabled ? 'Отправьте сообщение в AI, чтобы увидеть диагностику.' : 'Включите запись, чтобы начать.'}</div> : <div className="dev-panel__entries">{state.entries.map(entry => <details key={entry.id}><summary><span className="dev-method">{entry.method}</span><span className="dev-path">{entry.path}</span><span>{entry.native?.http_status ?? '—'} · {entry.duration === undefined ? '…' : `${entry.duration} ms`}</span></summary><div className="dev-entry"><small>{entry.time} · Клиент: {entry.result ?? 'выполняется'}</small><strong>Тело запроса</strong><pre>{JSON.stringify(entry.request, null, 2)}</pre><strong>Ответ сервера: разрешённые поля</strong><pre>{entry.native ? JSON.stringify(entry.native, null, 2) : 'Нет ответа или версия приложения не поддерживает диагностику.'}</pre></div></details>)}</div>}
      </div></section></div>, document.body)}
  </>
}
