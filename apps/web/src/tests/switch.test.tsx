import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Switch } from '../components/Switch'
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })
it('keeps the controlled value until its owner accepts the change and blocks pending requests', async () => {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  const change = vi.fn()
  await act(async () => { root!.render(<Switch label="Touch ID" checked={false} onCheckedChange={change} />) })
  const button = host.querySelector('button')!
  await act(async () => { button.click() })
  expect(change).toHaveBeenCalledWith(true)
  expect(button.getAttribute('aria-checked')).toBe('false')
  await act(async () => { root!.render(<Switch label="Touch ID" checked={true} pending onCheckedChange={change} />) })
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-checked')).toBe('true')
  expect(button.getAttribute('aria-busy')).toBe('true')
  await act(async () => { button.click() })
  expect(change).toHaveBeenCalledTimes(1)
})
