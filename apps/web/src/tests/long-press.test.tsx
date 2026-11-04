import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useLongPress } from '../lib/useLongPress'

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers() })

function Press({ onLong }: { onLong: () => void }) {
  return <div data-testid="press" {...useLongPress(onLong, 500)} />
}

it('fires only when the press is held past the delay and cancels on move', async () => {
  vi.useFakeTimers()
  const onLong = vi.fn()
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Press onLong={onLong} />))
  const target = host.querySelector<HTMLElement>('[data-testid=press]')!
  act(() => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  act(() => { vi.advanceTimersByTime(499) })
  expect(onLong).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(1) })
  expect(onLong).toHaveBeenCalledTimes(1)
  act(() => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  act(() => { target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })) })
  act(() => { vi.advanceTimersByTime(600) })
  expect(onLong).toHaveBeenCalledTimes(1)
  host.remove()
})
