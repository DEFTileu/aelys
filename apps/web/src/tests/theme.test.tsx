import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { getThemePreference, setThemePreference, useTheme } from '../lib/theme'
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear(); delete document.documentElement.dataset.theme; vi.unstubAllGlobals() })
it('persists system appearance and follows OS changes until explicitly overridden', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let dark = false
  const changes = new EventTarget()
  vi.stubGlobal('matchMedia', () => ({ get matches() { return dark }, addEventListener: changes.addEventListener.bind(changes), removeEventListener: changes.removeEventListener.bind(changes) }))
  function Probe() { const [theme, toggle] = useTheme(); return <button onClick={toggle}>{theme}</button> }
  setThemePreference('system')
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<Probe />))
  expect(host.textContent).toBe('light')
  expect(getThemePreference()).toBe('system')
  await act(async () => { dark = true; changes.dispatchEvent(new Event('change')) })
  expect(document.documentElement.dataset.theme).toBe('dark')
  await act(async () => host.querySelector('button')!.click())
  expect(localStorage.getItem('aelys.theme')).toBe('light')
  await act(async () => { dark = false; changes.dispatchEvent(new Event('change')); dark = true; changes.dispatchEvent(new Event('change')) })
  expect(host.textContent).toBe('light')
})
