import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FeedbackExamples, MotionExamples } from '../components/gallery/FeedbackExamples'

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks() })

it('saves locally and restores focus when the dialog closes', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) } })
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(<FeedbackExamples />) })
  const opener = host.querySelector('button')!
  await act(async () => { opener.focus(); opener.click() })
  expect(host.querySelector('dialog')!.open).toBe(true)
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(host.textContent).toContain('Пример обновлён')
  expect(document.activeElement).toBe(opener)
  expect(host.querySelector('dialog')!.open).toBe(false)
})

it('expires the toast and clears pending timers on unmount', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(<><FeedbackExamples /><MotionExamples /></>) })
  const buttons = Array.from(host.querySelectorAll('button'))
  await act(async () => { buttons.find((button) => button.textContent === 'Показать уведомление')!.click(); buttons.find((button) => button.textContent === 'Запустить пример')!.click() })
  expect(host.textContent).toContain('Пример уведомления')
  expect(host.querySelector('.motion-skeleton')).not.toBeNull()
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(host.textContent).toContain('Пример завершён')
  expect(host.querySelector('.motion-skeleton')).toBeNull()
  await act(async () => { vi.advanceTimersByTime(3500) })
  expect(host.textContent).not.toContain('Пример уведомления')
  await act(async () => { buttons.find((button) => button.textContent === 'Показать уведомление')!.click(); buttons.find((button) => button.textContent === 'Запустить пример')!.click() })
  expect(vi.getTimerCount()).toBe(2)
  await act(async () => { root!.unmount(); root = undefined })
  expect(vi.getTimerCount()).toBe(0)
})
