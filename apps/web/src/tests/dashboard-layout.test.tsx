import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'
import { HOME_LAYOUT_KEY, normalizeWidgetSize, readLayout, reorderLayout, type LayoutEntry } from '../views/desktop/homeLayout'

const client = vi.hoisted(() => ({ tasks: vi.fn(), calendarOccurrences: vi.fn(), projects: vi.fn(), notes: vi.fn(), financeTransactions: vi.fn(), focusSessions: vi.fn(), mailMessages: vi.fn(), activity: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); Object.values(client).forEach((method) => method.mockResolvedValue([]))
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {})
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function pointer(node: Element, type: string, x: number, y: number) {
  node.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 }))
}
async function click(node: HTMLElement) { await act(async () => node.click()) }
function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === text)!
}
async function customize(host: HTMLElement) { await click(button(host, 'Customize')) }
async function mount() {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<HomeView apiStatus="ready" />))
  const grid = host.querySelector<HTMLElement>('[aria-label="Dashboard widgets"]')!
  grid.style.gridTemplateColumns = '200px 200px 200px 200px'; grid.style.columnGap = '16px'
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) })
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 848, 560))
  ;[...grid.children].forEach((card, index) => vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(index % 4 * 216, Math.floor(index / 4) * 256, 200, 240)))
  return { host, grid }
}

describe('dashboard customization', () => {
  it('locks editing controls and does not move or save when dragging a heading', async () => {
    const { host, grid } = await mount()
    expect(host.querySelector('[aria-label="Move Today"]')).toBeNull()
    expect(host.querySelector('[aria-label="Resize Today"]')).toBeNull()
    expect(host.querySelector('[aria-label="Remove Today"]')).toBeNull()
    expect(host.querySelector('[aria-label="Size of Today"]')).toBeNull()
    const heading = grid.querySelector('[data-widget-id="today"] [data-widget-heading]')!
    await act(async () => { pointer(heading, 'pointerdown', 15, 25); pointer(heading, 'pointermove', 300, 100); pointer(heading, 'pointerup', 300, 100) })
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['today', 'cal'])
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    await customize(host)
    expect(host.querySelector('[aria-label="Move Today"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Resize Today"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Remove Today"]')).not.toBeNull()
  })

  it('moves a widget by pointer in Customize and persists the order', async () => {
    const { host, grid } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Move Today"]')!
    await act(async () => pointer(handle, 'pointerdown', 15, 25))
    await act(async () => pointer(handle, 'pointermove', 300, 100))
    expect(grid.children[1]?.hasAttribute('data-drop-target')).toBe(true)
    await act(async () => pointer(handle, 'pointerup', 300, 100))
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['cal', 'today'])
    expect(readLayout().slice(0, 2).map(([id]) => id)).toEqual(['cal', 'today'])
  })

  it('snaps pointer resize to the grid and restores the saved size after remount', async () => {
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['today', 1, 240], ['cal', 2, 240]]))
    const { host, grid } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => pointer(resize, 'pointerdown', 200, 240))
    await act(async () => pointer(resize, 'pointermove', 410, 350))
    await act(async () => pointer(resize, 'pointerup', 410, 350))
    expect(readLayout()[0]).toEqual(['today', 2, 240])
    expect((grid.children[0] as HTMLElement).style.height).toBe('240px')
    await act(async () => root!.unmount()); root = undefined
    const restored = await mount()
    expect((restored.grid.children[0] as HTMLElement).style.height).toBe('240px')
    expect((restored.grid.children[0] as HTMLElement).style.getPropertyValue('--widget-span')).toBe('2')
  })

  it('snaps a large vertical pointer resize to four rows', async () => {
    const { host } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => pointer(resize, 'pointerdown', 200, 240))
    await act(async () => pointer(resize, 'pointermove', 410, 600))
    await act(async () => pointer(resize, 'pointerup', 410, 600))
    expect(readLayout()[0]).toEqual(['today', 2, 496])
  })

  it('offers preset sizes and button and keyboard alternatives for reordering', async () => {
    const { host } = await mount(); await customize(host)
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Size of Today"]')!
    expect([...select.options].map((option) => option.value)).toEqual(['small', 'wide', 'large', 'full'])
    for (const [value, span, height] of [['wide', 2, 240], ['large', 2, 496], ['full', 4, 240], ['small', 1, 240]] as const) {
      await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(readLayout()[0]).toEqual(['today', span, height])
    }
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Move Today later"]')!)
    expect(readLayout()[1]?.[0]).toBe('today')
    const handle = host.querySelector('[aria-label="Move Today"]')!
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(readLayout()[0]?.[0]).toBe('today')
  })

  it('removes and adds a widget in Customize and persists both changes', async () => {
    const { host, grid } = await mount(); await customize(host)
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Remove Today"]')!)
    expect(grid.querySelector('[data-widget-id="today"]')).toBeNull()
    expect(readLayout().some(([id]) => id === 'today')).toBe(false)
    await click(button(host, 'Widget'))
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.includes('Today'))!
    await click(item)
    expect(grid.querySelector('[data-widget-id="today"]')).not.toBeNull()
    expect(readLayout().some(([id]) => id === 'today')).toBe(true)
    await click(button(host, 'Done'))
    expect(host.querySelector('[aria-label="Remove Today"]')).toBeNull()
  })

  it('cancels pointer resize on pointercancel and Escape', async () => {
    const { host, grid } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => { pointer(resize, 'pointerdown', 200, 240); pointer(resize, 'pointermove', 410, 600) })
    await act(async () => pointer(resize, 'pointercancel', 410, 600))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect((grid.children[0] as HTMLElement).style.height).toBe('240px')
    await act(async () => { pointer(resize, 'pointerdown', 200, 240); pointer(resize, 'pointermove', 410, 600) })
    await act(async () => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => pointer(resize, 'pointerup', 410, 600))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect((grid.children[0] as HTMLElement).style.height).toBe('240px')
    await act(async () => { pointer(resize, 'pointerdown', 200, 240); pointer(resize, 'pointermove', 410, 600) })
    await act(async () => pointer(resize, 'lostpointercapture', 410, 600))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect((grid.children[0] as HTMLElement).style.height).toBe('240px')
  })

  it('Done cancels a gesture and removes editing affordances', async () => {
    const { host, grid } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Move Today"]')!
    await act(async () => { pointer(handle, 'pointerdown', 15, 25); pointer(handle, 'pointermove', 300, 100) })
    await click(button(host, 'Done'))
    expect(host.querySelector('[aria-label="Move Today"]')).toBeNull()
    expect(host.querySelector('[aria-label="Resize Today"]')).toBeNull()
    expect(host.querySelector('[aria-label="Remove Today"]')).toBeNull()
    expect(host.querySelector('[aria-label="Size of Today"]')).toBeNull()
    expect(grid.querySelector('[data-drop-target]')).toBeNull()
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['today', 'cal'])
  })

  it('reports a blocked local save instead of claiming the layout is durable', async () => {
    const { host } = await mount(); await customize(host)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded') })
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Size of Today"]')!
    await act(async () => { select.value = 'wide'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('Не удалось сохранить расположение')
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })
})

describe('layout durability and validation', () => {
  it('normalizes legacy sizes to the nearest supported width and row height', () => {
    expect(normalizeWidgetSize(1, 264)).toEqual({ span: 1, height: 240, rows: 2 })
    expect(normalizeWidgetSize(2, 384)).toEqual({ span: 2, height: 496, rows: 4 })
    expect(normalizeWidgetSize(3.6, 720)).toEqual({ span: 2, height: 496, rows: 4 })
    expect(normalizeWidgetSize(1, 496)).toEqual({ span: 2, height: 496, rows: 4 })
    expect(normalizeWidgetSize(1.8, 240)).toEqual({ span: 2, height: 240, rows: 2 })
  })
  it('migrates legacy tuples, removes duplicates and rejects unknown/invalid cards', () => {
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['today', 10], ['cal', 0, 9999], ['today', 1], ['unknown', 2], ['fin', null], ['focus', 2, 384]]))
    expect(readLayout()).toEqual([['today', 4, 240], ['cal', 2, 496], ['focus', 2, 496]])
  })
  it('reorders by insertion while keeping sizes and hidden entries attached to their widgets', () => {
    const layout: LayoutEntry[] = [['today', 2, 496], ['activity', 4, 240], ['cal', 1, 240], ['focus', 1, 240]]
    expect(reorderLayout(layout, 'today', 'focus')).toEqual([['activity', 4, 240], ['cal', 1, 240], ['focus', 1, 240], ['today', 2, 496]])
    expect(layout[0]).toEqual(['today', 2, 496])
  })
})
