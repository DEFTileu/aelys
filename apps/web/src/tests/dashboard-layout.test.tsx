import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'
import { HOME_LAYOUT_KEY, MOBILE_HOME_LAYOUT_KEY, PREVIOUS_HOME_LAYOUT_KEY, LEGACY_HOME_LAYOUT_KEY, LEGACY_MOBILE_HOME_LAYOUT_KEY, WIDGET_SIZES, WIDGET_IDS, saveLayout, normalizeWidgetSize, readLayout, reorderLayout, type LayoutEntry } from '../views/desktop/homeLayout'

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
  grid.style.gridTemplateColumns = '200px 200px 200px 200px'; grid.style.columnGap = '16px'; grid.style.gridAutoRows = '176px'
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) })
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 848, 560))
  ;[...grid.children].forEach((card, index) => vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(index % 4 * 216, Math.floor(index / 4) * 256, 200, 176)))
  return { host, grid }
}

describe('dashboard customization', () => {
  it('adapts automatically on first load and container resize without saving calculated dimensions', async () => {
    let resize: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
    client.tasks.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, status: 'todo', due_at: null })))
    const { grid } = await mount()
    const today = grid.querySelector<HTMLElement>('[data-widget-id="today"]')!
    const focus = grid.querySelector<HTMLElement>('[data-widget-id="focus"]')!
    expect(today.dataset.sizing).toBe('auto')
    expect(today.dataset.rows).toBe('3')
    expect(today.querySelectorAll('[role="checkbox"]')).toHaveLength(8)
    let width = 1280
    Object.defineProperty(grid, 'clientWidth', { get: () => width })
    await act(async () => resize?.())
    expect(grid.style.getPropertyValue('--widget-columns')).toBe('4')
    expect(focus.dataset.size).toBe('1x1')
    width = 550
    await act(async () => resize?.())
    expect(grid.style.getPropertyValue('--widget-columns')).toBe('2')
    expect(focus.dataset.size).toBe('2x1')
    width = 288
    await act(async () => resize?.())
    expect(grid.style.getPropertyValue('--widget-columns')).toBe('1')
    expect(focus.dataset.size).toBe('1x1')
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })

  it('lets a pinned size return to automatic and persists that choice after reopening', async () => {
    const { host, grid } = await mount(); await customize(host)
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Size of Today"]')!
    expect(select.value).toBe('auto')
    await act(async () => { select.value = '1x3'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(grid.querySelector<HTMLElement>('[data-widget-id="today"]')!.dataset.sizing).toBe('manual')
    await act(async () => { select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(readLayout()[0]).toEqual(['today', 0])
    await act(async () => root!.unmount()); root = undefined
    const restored = await mount()
    const today = restored.grid.querySelector<HTMLElement>('[data-widget-id="today"]')!
    expect(today.dataset.sizing).toBe('auto')
    expect(today.dataset.size).toBe('1x1')
  })
  it('saves all six tile formats for every widget', async () => {
    saveLayout(WIDGET_IDS.map(id => [id, 1, 176]))
    const { host, grid } = await mount(); await customize(host)
    for (const id of WIDGET_IDS) {
      const card = grid.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
      const select = card.querySelector<HTMLSelectElement>('select')!
      for (const size of WIDGET_SIZES.filter(size => size.span <= 2)) {
        await act(async () => { select.value = size.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
        expect(card.dataset.size).toBe(size.id)
        expect(card.dataset.rows).toBe(String(size.rows))
        expect(readLayout().find(([key]) => key === id)).toEqual([id, size.span, size.height])
      }
    }
  })

  it('changes width and height independently with keyboard resizing', async () => {
    const { host } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    for (const [key, span, height] of [['ArrowDown', 1, 368], ['ArrowDown', 1, 560], ['ArrowRight', 2, 560], ['ArrowLeft', 1, 560], ['ArrowUp', 1, 368]] as const) {
      await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
      expect(readLayout()[0]).toEqual(['today', span, height])
    }
  })

  it('preserves saved width when resizing vertically in a collapsed one-column grid', async () => {
    saveLayout([['today', 2, 176]])
    const { host, grid } = await mount(); await customize(host)
    grid.style.gridTemplateColumns = '848px'
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => { pointer(handle, 'pointerdown', 200, 176); pointer(handle, 'pointermove', 200, 368) })
    await act(async () => pointer(handle, 'pointerup', 200, 368))
    expect(readLayout()[0]).toEqual(['today', 2, 368])
  })

  it.each([
    ['today', '.home-task-row'], ['cal', '.home-event-title'], ['proj', '.home-records > div'],
    ['notes', '.home-note-row'], ['kb', '.home-note-row'], ['fin', '.home-finance-row'],
    ['mail', '.home-mail-row'], ['activity', '.home-activity > div'],
  ])('adapts %s records to all three heights', async (id, selector) => {
    const records = Array.from({ length: 12 }, (_, index) => ({ id: `record-${index}`, title: `Record ${index}`, name: `Project ${index}`, status: 'todo', due_at: null, starts_at: '2026-10-31T10:00:00Z', ends_at: '2026-10-31T11:00:00Z', markdown_body: 'Note preview', currency: 'KZT', amount: '0.0001', notes: '', sender: 'Sender', subject: 'Subject', received_at: '2026-10-31T10:00:00Z', event_kind: 'task.created', actor_kind: 'owner', occurred_at: '2026-10-31T10:00:00Z' }))
    Object.entries(client).forEach(([key, method]) => method.mockResolvedValue(key === 'focusSessions' ? [] : records))
    saveLayout(WIDGET_IDS.map(key => [key, 1, 176]))
    const { host, grid } = await mount(); await customize(host)
    const card = grid.querySelector(`[data-widget-id="${id}"]`)!
    const select = card.querySelector<HTMLSelectElement>('select')!
    for (const [size, expected] of [['1x1', id === 'fin' ? 1 : 2], ['1x2', 6], ['1x3', 10]] as const) {
      await act(async () => { select.value = size; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(card.querySelectorAll(selector)).toHaveLength(expected)
    }
    if (id === 'fin') expect(card.querySelector('.home-finance-total strong')?.textContent).toBe('0.0012')
  })

  it('adapts the visible records during resize preview and restores them on cancellation', async () => {
    saveLayout([['today', 1, 176]])
    client.tasks.mockResolvedValue(Array.from({ length: 12 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, status: 'todo', due_at: null })))
    const { host, grid } = await mount(); await customize(host)
    const card = grid.querySelector('[data-widget-id="today"]')!
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
    await act(async () => { pointer(handle, 'pointerdown', 200, 176); pointer(handle, 'pointermove', 200, 560) })
    expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(10)
    expect(readLayout()).toEqual([['today', 1, 176]])
    await act(async () => pointer(handle, 'pointercancel', 200, 560))
    expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
  })
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
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['today', 1, 176], ['cal', 2, 176]]))
    const { host, grid } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => pointer(resize, 'pointerdown', 200, 176))
    await act(async () => pointer(resize, 'pointermove', 410, 230))
    await act(async () => pointer(resize, 'pointerup', 410, 230))
    expect(readLayout()[0]).toEqual(['today', 2, 176])
    expect((grid.children[0] as HTMLElement).style.height).toBe('176px')
    await act(async () => root!.unmount()); root = undefined
    const restored = await mount()
    expect((restored.grid.children[0] as HTMLElement).style.height).toBe('176px')
    expect((restored.grid.children[0] as HTMLElement).style.getPropertyValue('--widget-span')).toBe('2')
  })

  it('snaps a large vertical pointer resize to three rows', async () => {
    const { host } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => pointer(resize, 'pointerdown', 200, 176))
    await act(async () => pointer(resize, 'pointermove', 410, 600))
    await act(async () => pointer(resize, 'pointerup', 410, 600))
    expect(readLayout()[0]).toEqual(['today', 2, 560])
  })

  it('offers preset sizes and button and keyboard alternatives for reordering', async () => {
    const { host } = await mount(); await customize(host)
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Size of Today"]')!
    expect([...select.options].map((option) => option.value)).toEqual(['auto', ...WIDGET_SIZES.map(size => size.id)])
    for (const { id: value, span, height } of WIDGET_SIZES) {
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
    await act(async () => { pointer(resize, 'pointerdown', 200, 176); pointer(resize, 'pointermove', 410, 600) })
    await act(async () => pointer(resize, 'pointercancel', 410, 600))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect((grid.children[0] as HTMLElement).style.height).toBe('176px')
    await act(async () => { pointer(resize, 'pointerdown', 200, 176); pointer(resize, 'pointermove', 410, 600) })
    await act(async () => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => pointer(resize, 'pointerup', 410, 600))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect((grid.children[0] as HTMLElement).style.height).toBe('176px')
    await act(async () => { pointer(resize, 'pointerdown', 200, 176); pointer(resize, 'pointermove', 410, 600) })
    await act(async () => pointer(resize, 'lostpointercapture', 410, 600))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect((grid.children[0] as HTMLElement).style.height).toBe('176px')
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
    await act(async () => { select.value = '2x1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('Не удалось сохранить расположение')
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })
})

describe('layout durability and validation', () => {
  it('adopts automatic sizing for existing v2 layouts without restoring removed widgets or changing order', () => {
    localStorage.setItem(PREVIOUS_HOME_LAYOUT_KEY, JSON.stringify([['focus', 2, 560], ['today', 1, 368]]))
    expect(readLayout()).toEqual([['focus', 0], ['today', 0]])
    expect(localStorage.getItem(PREVIOUS_HOME_LAYOUT_KEY)).toBe(JSON.stringify([['focus', 2, 560], ['today', 1, 368]]))
    saveLayout([['today', 1, 560]])
    expect(readLayout()).toEqual([['today', 1, 560]])
  })
  it.each([false, true])('adopts automatic sizing from v1 while preserving widget order (mobile=%s)', mobile => {
    const legacyKey = mobile ? LEGACY_MOBILE_HOME_LAYOUT_KEY : LEGACY_HOME_LAYOUT_KEY
    localStorage.setItem(legacyKey, JSON.stringify([['today', 1, 264], ['cal', 2, 264], ['focus', 2, 544], ['activity', 4, 264]]))
    const migrated = readLayout(mobile)
    expect(migrated).toEqual([['today', 0], ['cal', 0], ['focus', 0], ['activity', 0]])
    saveLayout(migrated, mobile)
    localStorage.setItem(legacyKey, '[]')
    expect(readLayout(mobile)).toEqual(migrated)
  })
  it('keeps desktop and mobile layouts durable and independent', () => {
    const desktop: LayoutEntry[] = [['today', 2, 368]]
    const mobile: LayoutEntry[] = [['mail', 2, 176], ['focus', 1, 176]]
    expect(readLayout(true).map(([id]) => id)).toEqual(['today', 'focus', 'weather', 'cal', 'mail', 'notes', 'fin', 'proj'])
    saveLayout(desktop); saveLayout(mobile, true)
    expect(readLayout()).toEqual(desktop)
    expect(readLayout(true)).toEqual(mobile)
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).not.toEqual(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY))
  })
  it('normalizes legacy sizes to the nearest supported width and row height', () => {
    expect(normalizeWidgetSize(1, 176)).toEqual({ span: 1, height: 176, rows: 1 })
    expect(normalizeWidgetSize(2, 384)).toEqual({ span: 2, height: 368, rows: 2 })
    expect(normalizeWidgetSize(3.6, 720)).toEqual({ span: 4, height: 176, rows: 1 })
    expect(normalizeWidgetSize(1, 368)).toEqual({ span: 1, height: 368, rows: 2 })
    expect(normalizeWidgetSize(1.8, 176)).toEqual({ span: 2, height: 176, rows: 1 })
  })
  it('migrates legacy tuples, removes duplicates and rejects unknown/invalid cards', () => {
    localStorage.setItem(LEGACY_HOME_LAYOUT_KEY, JSON.stringify([['today', 10], ['cal', 0, 9999], ['today', 1], ['unknown', 2], ['fin', null], ['focus', 2, 384]]))
    expect(readLayout()).toEqual([['today', 0], ['cal', 0], ['focus', 0]])
  })
  it('reorders by insertion while keeping sizes and hidden entries attached to their widgets', () => {
    const layout: LayoutEntry[] = [['today', 2, 368], ['activity', 4, 176], ['cal', 1, 176], ['focus', 1, 176]]
    expect(reorderLayout(layout, 'today', 'focus')).toEqual([['activity', 4, 176], ['cal', 1, 176], ['focus', 1, 176], ['today', 2, 368]])
    expect(layout[0]).toEqual(['today', 2, 368])
  })
})
