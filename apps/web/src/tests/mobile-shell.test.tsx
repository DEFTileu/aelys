import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileShell } from '../components/MobileShell'
import { getRoute } from '../lib/router'
import { getDesktopState, setSettings } from '../lib/desktopStore'
import { WALLPAPERS } from '../data/desktop/settings'

vi.mock('../components/NotificationCenter', () => ({ NotificationCenter: ({ route }: { route: string }) => <button>Notifications {route}</button> }))
vi.mock('../components/Weather', () => ({ WeatherSettingsDialog: () => null }))

let root: ReturnType<typeof createRoot> | undefined
function TestShell() {
  const [route, setRoute] = useState(getRoute())
  useEffect(() => { const update = () => setRoute(getRoute()); window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update) }, [])
  return <MobileShell route={route} apiStatus="ready" theme="light" onToggleTheme={() => {}}><div>Content {route}</div></MobileShell>
}
async function render() { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<TestShell />)); return host }
function button(host: ParentNode, label: string) { return [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent === label)! }
async function click(element: HTMLElement) { await act(async () => element.click()) }
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; history.replaceState({}, '', '/'); vi.restoreAllMocks() })

describe('MobileShell', () => {
  it('opens and dismisses the app sheet by keyboard and backdrop, restoring focus', async () => {
    const host = await render(); const trigger = button(host, 'All apps'); trigger.focus(); await click(trigger)
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? host.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('mobile-apps-title')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close all apps')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
    await click(trigger); await click(host.querySelector<HTMLElement>('.mobile-shell__backdrop')!); expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
  it('keeps the Home header to one line: logo, apps, search, notifications and avatar', async () => {
    const host = await render()
    const header = host.querySelector('.mobile-shell__header')!
    expect([...header.children].map(node => node.getAttribute('aria-label') ?? node.textContent)).toEqual(['Aelys', 'All apps', 'Search', 'Notifications /', 'Profile and settings'])
    expect(header.querySelector('.mobile-shell__logo svg, .mobile-shell__logo img, .mobile-shell__logo [class*="mark"]')).not.toBeNull()
    expect(host.querySelector('.mobile-shell__weather')).toBeNull()
    expect(header.nextElementSibling?.tagName).toBe('MAIN')
  })
  it('pins the AI bar and reserves its height in the content padding', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(104)
    const host = await render()
    const shell = host.querySelector<HTMLElement>('.mobile-shell--home')!
    expect(shell.style.getPropertyValue('--mobile-bar-height')).toBe('104px')
    const bar = host.querySelector('.mobile-shell__bottom')!
    expect(bar.querySelector('form.mobile-shell__ask')).not.toBeNull()
    expect(bar.parentElement).toBe(shell)
    await click(button(host, 'Profile and settings'))
    expect(host.querySelector('.mobile-shell--home')).toBeNull()
  })
  it('navigates between modules through the app sheet and returns home', async () => {
    const host = await render(); await click(button(host, 'All apps')); await click(button(host.querySelector('[role="dialog"]')!, 'Finances'))
    expect(location.pathname).toBe('/finance'); expect(host.textContent).toContain('Content /finance'); expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(host.querySelector('.mobile-shell__wallpaper--inner')).not.toBeNull()
    // The design puts the apps grid on Home only: inner screens go back first.
    expect(host.querySelector('button[aria-label="All apps"]')).toBeNull()
    await click(button(host, 'Back')); expect(location.pathname).toBe('/')
    await click(button(host, 'All apps')); await click(button(host.querySelector('[role="dialog"]')!, 'Tasks')); expect(location.pathname).toBe('/tasks')
    await click(button(host, 'Back')); await click(button(host, 'All apps')); await click(button(host.querySelector('[role="dialog"]')!, 'Apps')); expect(location.pathname).toBe('/apps'); expect(host.querySelector('.mobile-shell__title')?.textContent).toBe('Apps')
    await click(button(host, 'Back')); expect(location.pathname).toBe('/')
  })
  it('names the open settings section in the header, with one back button', async () => {
    history.replaceState({}, '', '/settings?section=profile'); const host = await render()
    expect(host.querySelector('.mobile-shell__title')?.textContent).toBe('Profile')
    expect(host.querySelectorAll('button[aria-label="Back"]')).toHaveLength(1)
    await click(button(host, 'Back')); expect(host.querySelector('.mobile-shell__title')?.textContent).toBe('Settings')
  })
  it('steps back from a settings panel to the list before going Home', async () => {
    history.replaceState({}, '', '/settings?section=notifications'); const host = await render()
    await click(button(host, 'Back')); expect(location.pathname + location.search).toBe('/settings')
    await click(button(host, 'Back')); expect(location.pathname).toBe('/')
  })
  it('uses the selected wallpaper on home and routes the composer to AI', async () => {
    const previous = getDesktopState(); setSettings({ wallpaper: 1, customWallpaper: null }); const host = await render()
    expect(host.querySelector<HTMLElement>('.mobile-shell__wallpaper')!.style.backgroundImage).toContain(WALLPAPERS[1])
    const input = host.querySelector<HTMLInputElement>('input')!; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Plan my day'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(location.pathname).toBe('/ai'); expect(getDesktopState().pendingAsk).toBe('Plan my day')
    setSettings({ wallpaper: previous.wallpaper, customWallpaper: previous.customWallpaper })
  })
})
