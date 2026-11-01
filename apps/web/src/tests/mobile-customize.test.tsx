import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileCustomizeView } from '../views/MobileCustomizeView'
import { HOME_LAYOUT_KEY, MOBILE_HOME_LAYOUT_KEY, layoutKey, pendingHighlight, readLayout } from '../views/desktop/homeLayout'

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
const width = window.innerWidth
beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); window.history.replaceState({}, '', '/widgets'); pendingHighlight.key = '' })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }) })
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<MobileCustomizeView />)) }
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')]
const press = async (predicate: (button: HTMLButtonElement) => boolean) => { const button = buttons().find(predicate)!; expect(button).toBeTruthy(); await act(async () => button.click()) }

it('opens the Add widget sheet full-screen instead of a list-form customize screen', async () => {
  await mount()
  expect(host.querySelector('.add-widget-backdrop--full [role="dialog"][aria-label="Add widget"]')).not.toBeNull()
  expect(host.querySelector('[role="tablist"], ol, .mobile-customize')).toBeNull()
  expect(host.querySelector('[aria-label^="Move"], [aria-label^="Size of"]')).toBeNull()
})

it('adds a widget to the mobile layout only, at the chosen size, and returns Home with a highlight request', async () => {
  localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['cal', 1, 264]]))
  await mount()
  await press(button => button.textContent === 'L')
  await press(button => button.textContent === 'Add')
  const saved = readLayout(true)
  expect(saved.at(-1)).toEqual(['today', 2, 544, expect.stringMatching(/^today-/)])
  expect(pendingHighlight.key).toBe(layoutKey(saved.at(-1)!))
  expect(JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY)!)).toEqual([['cal', 1, 264]])
  expect(window.location.pathname).toBe('/')
})

it('adds a new widget at the default size M without a duplicate key', async () => {
  await mount()
  const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent?.includes('Knowledge'))!
  await act(async () => option.click())
  await press(button => button.textContent === 'Add')
  expect(readLayout(true).at(-1)).toEqual(['kb', 2, 264])
})

it('closes back to Home with Cancel and changes nothing', async () => {
  await mount()
  await press(button => button.textContent === 'Cancel')
  expect(window.location.pathname).toBe('/')
  expect(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY)).toBeNull()
})

it('reports persistence failures and stays on the sheet', async () => {
  await mount()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  await press(button => button.textContent === 'Add')
  expect(host.textContent).toContain('Could not save')
  expect(window.location.pathname).toBe('/widgets')
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
})
