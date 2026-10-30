import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppShell } from '../components/AppShell'

vi.mock('../components/NotificationCenter', () => ({ NotificationCenter: () => null }))
vi.mock('../components/Weather', () => ({ WeatherPill: () => null, WeatherSettingsDialog: () => null }))
vi.mock('../components/CommandPalette', () => ({ CommandPalette: () => null }))
let root: ReturnType<typeof createRoot> | undefined
const originalWidth = window.innerWidth
afterEach(() => {
  act(() => root?.unmount()); document.body.innerHTML = ''
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
})

it('keeps the routed editor mounted and its draft intact across desktop/mobile breakpoints', async () => {
  let mounts = 0; let unmounts = 0
  function Draft() {
    const [draft, setDraft] = useState('')
    useEffect(() => { mounts++; return () => { unmounts++ } }, [])
    return <input aria-label="Unsaved draft" value={draft} onChange={event => setDraft(event.target.value)} />
  }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<AppShell route="/notes" apiStatus="ready" theme="light" onToggleTheme={() => {}}><Draft /></AppShell>))
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Unsaved draft"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(field, 'Keep this draft'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  for (const width of [412, 1200]) {
    await act(async () => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); window.dispatchEvent(new Event('resize')) })
    expect(host.querySelector('input[aria-label="Unsaved draft"]')).toBe(field)
    expect(field.value).toBe('Keep this draft')
    expect(host.querySelectorAll('main')).toHaveLength(1)
    expect(!!host.querySelector('.mobile-shell')).toBe(width === 412)
  }
  expect(mounts).toBe(1); expect(unmounts).toBe(0)
})
