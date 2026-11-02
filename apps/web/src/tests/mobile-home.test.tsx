import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'
import { MobileCustomizeView } from '../views/MobileCustomizeView'
import { ComponentsView } from '../views/ComponentsView'
import { MOBILE_HOME_LAYOUT_KEY, readLayout } from '../views/desktop/homeLayout'

const client = vi.hoisted(() => ({ tasks: vi.fn(), calendarOccurrences: vi.fn(), projects: vi.fn(), notes: vi.fn(), financeTransactions: vi.fn(), financeBudgets: vi.fn(), focusSessions: vi.fn(), mailMessages: vi.fn(), activity: vi.fn(), updateTask: vi.fn(), createTask: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
const viewport = (mobile: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: mobile && query === '(max-width: 700px)', addEventListener() {}, removeEventListener() {} }))
const mobileViewport = () => viewport(true)
const mount = async (node: ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(node)) }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.values(client).forEach(method => method.mockResolvedValue([]))
  client.tasks.mockResolvedValue([{ id: 'task-1', title: 'Real task', status: 'todo', due_at: null, version: 1 }])
  window.history.replaceState({}, '', '/')
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('mobile Home', () => {
  it('renders the mobile composition without the desktop toolbar or edit mode', async () => {
    mobileViewport()
    await mount(<HomeView apiStatus="ready" />)
    expect(host.querySelector('.home-m')).not.toBeNull()
    expect(host.querySelector('.home-layout-toolbar')).toBeNull()
    expect(host.querySelector('[aria-label="Dashboard widgets"]')).not.toBeNull()
  })

  it('opens Customize when a widget heading is long-pressed', async () => {
    mobileViewport()
    vi.useFakeTimers()
    await mount(<HomeView apiStatus="ready" />)
    const heading = host.querySelector<HTMLElement>('[data-widget-heading]')!
    await act(async () => { heading.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })) })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(window.location.pathname).toBe('/widgets')
  })

  it('opens Customize from the Customize home button', async () => {
    mobileViewport()
    await mount(<HomeView apiStatus="ready" />)
    await act(async () => button('Customize home').click())
    expect(window.location.pathname).toBe('/widgets')
  })
})

describe('mobile Customize', () => {
  it('lists the Home widgets, removes one from the mobile layout and opens Add widget as a bottom sheet', async () => {
    mobileViewport()
    await mount(<MobileCustomizeView />)
    expect(host.querySelector('.customize-m')).not.toBeNull()
    const before = readLayout(true).length
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove Today"]')!.click())
    expect(readLayout(true).length).toBe(before - 1)
    expect(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY)).not.toBeNull()
    await act(async () => button('Add widget').click())
    expect(host.querySelector('.customize-m .add-widget-backdrop [role="dialog"][aria-label="Add widget"]')).not.toBeNull()
  })
})

describe('mobile Components gallery', () => {
  it('marks the gallery root for the mobile layout only on phone widths', async () => {
    mobileViewport()
    await mount(<ComponentsView theme="light" onToggleTheme={() => {}} />)
    expect(host.querySelector('.component-gallery.component-gallery--m')).not.toBeNull()
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''
    viewport(false)
    await mount(<ComponentsView theme="light" onToggleTheme={() => {}} />)
    expect(host.querySelector('.component-gallery--m')).toBeNull()
  })
})
