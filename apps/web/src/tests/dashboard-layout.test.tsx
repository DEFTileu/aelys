import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'
import { HOME_LAYOUT_KEY, WIDGET_SIZES, WIDGET_IDS, saveLayout, readLayout } from '../views/desktop/homeLayout'

const client = vi.hoisted(() => ({ tasks: vi.fn(), calendarOccurrences: vi.fn(), projects: vi.fn(), notes: vi.fn(), financeTransactions: vi.fn(), focusSessions: vi.fn(), mailMessages: vi.fn(), activity: vi.fn(), createTask: vi.fn() }))
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
async function choose(select: HTMLSelectElement, value: string) { await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function mount() {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<HomeView apiStatus="ready" />))
  const grid = host.querySelector<HTMLElement>('[aria-label="Dashboard widgets"]')!
  grid.style.gridTemplateColumns = '264px 264px 264px 264px'; grid.style.columnGap = '16px'; grid.style.gridAutoRows = '264px'
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) })
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1104, 560))
  ;[...grid.children].forEach((card, index) => vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(index % 4 * 280, Math.floor(index / 4) * 280, 264, 264)))
  return { host, grid }
}
const tasks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, status: 'todo', due_at: null }))

describe('dashboard widgets', () => {
  it('renders the design default sizes with no automatic sizing and saves nothing', async () => {
    const { grid } = await mount()
    expect([...grid.children].map(card => [card.getAttribute('data-widget-id'), (card as HTMLElement).dataset.sizeKey])).toEqual([['today', 'M'], ['focus', 'S'], ['weather', 'S'], ['cal', 'M'], ['proj', 'M'], ['fin', 'M'], ['notes', 'S'], ['mail', 'S']])
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })

  it('does not grow a card with its record count: Today M always shows at most four tasks', async () => {
    client.tasks.mockResolvedValue(tasks(12))
    const { grid } = await mount()
    expect(grid.querySelector('[data-widget-id="today"]')!.querySelectorAll('[role="checkbox"]')).toHaveLength(4)
  })

  it.each(WIDGET_IDS.filter(id => id !== 'weather'))('renders a different layout for %s at S, M and L', async (id) => {
    const at = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString()
    const records = Array.from({ length: 12 }, (_, index) => ({ id: `record-${index}`, title: `Record ${index}`, name: `Project ${index}`, status: 'todo', due_at: at(index), starts_at: at(index + 1), ends_at: at(index + 1.5), markdown_body: 'Note preview', currency: 'KZT', amount: '1.5', type: 'income', occurred_at: at(-index), notes: '', sender: 'Sender', subject: 'Subject', body: 'Body', received_at: at(-index), event_kind: 'task.created', actor_kind: 'owner', project_id: null, elapsed_seconds: 60 }))
    Object.entries(client).forEach(([key, method]) => method.mockResolvedValue(key === 'focusSessions' ? [] : key === 'createTask' ? {} : records))
    saveLayout(WIDGET_IDS.map(key => [key, 1, 264]))
    const { host, grid } = await mount(); await customize(host)
    const card = grid.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
    const select = card.querySelector<HTMLSelectElement>('select')!
    const html: string[] = []
    for (const size of ['1x1', '2x1', '2x2']) {
      await choose(select, size)
      html.push(card.querySelector('.home-widget-body')!.innerHTML)
    }
    expect(new Set(html).size).toBe(3)
  })

  it('shows one muted line plus one action when empty, and Can’t load · Retry when loading fails', async () => {
    const { grid } = await mount()
    const empty = grid.querySelector('[data-widget-id="proj"] .wb-empty')!
    expect(empty.textContent).toContain('No projects yet.')
    expect(empty.querySelectorAll('button')).toHaveLength(1)
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    client.projects.mockRejectedValue(new Error('offline'))
    const failed = await mount()
    const retry = failed.grid.querySelector('[data-widget-id="proj"] .wb-empty')!
    expect(retry.textContent).toContain('Can’t load')
    client.projects.mockResolvedValue([{ id: 'p', name: 'Alpha', status: 'active', description: '' }])
    await click(retry.querySelector('button')!)
    expect(failed.grid.querySelector('[data-widget-id="proj"]')!.textContent).toContain('Alpha')
  })

  it('never sums currencies in Finances', async () => {
    const tx = (id: string, currency: string, amount: string) => ({ id, currency, amount, type: 'income', occurred_at: new Date().toISOString(), notes: '' })
    client.financeTransactions.mockResolvedValue([tx('a', 'KZT', '10'), tx('b', 'KZT', '5'), tx('c', 'USD', '100')])
    const { grid } = await mount()
    const text = grid.querySelector('[data-widget-id="fin"]')!.textContent!
    expect(text).toContain('15.0')
    expect(text).toContain('KZT')
    expect(text).not.toContain('115')
    expect(text).toContain('1 more currency')
  })

  it('adds a task from the Today L quick-add field', async () => {
    saveLayout([['today', 2, 544]])
    client.createTask.mockResolvedValue({ id: 'new', title: 'Buy milk', status: 'todo', due_at: null })
    const { host } = await mount()
    const input = host.querySelector<HTMLInputElement>('[aria-label="Add a task"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Buy milk'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(client.createTask).toHaveBeenCalledWith({ title: 'Buy milk' }, { queueOnOffline: false })
    expect(host.textContent).toContain('Buy milk')
  })
})

describe('dashboard customization', () => {
  it('saves all four sizes for every widget', async () => {
    saveLayout(WIDGET_IDS.map(id => [id, 1, 264]))
    const { host, grid } = await mount(); await customize(host)
    for (const id of WIDGET_IDS) {
      const card = grid.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
      const select = card.querySelector<HTMLSelectElement>('select')!
      expect([...select.options].map(option => option.value)).toEqual(WIDGET_SIZES.map(size => size.id))
      for (const size of WIDGET_SIZES) {
        await choose(select, size.id)
        expect(card.dataset.size).toBe(size.id)
        expect(card.dataset.rows).toBe(String(size.rows))
        expect(readLayout().find(([key]) => key === id)).toEqual([id, size.span, size.height])
      }
    }
  })

  it('snaps keyboard resizing to S, M, L and Tall', async () => {
    const { host } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    for (const [key, span, height] of [['ArrowDown', 2, 544], ['ArrowLeft', 1, 544], ['ArrowUp', 1, 264], ['ArrowRight', 2, 264]] as const) {
      await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
      expect(readLayout()[0]).toEqual(['today', span, height])
    }
  })

  it('preserves saved width when resizing vertically in a collapsed one-column grid', async () => {
    saveLayout([['today', 1, 264]])
    const { host, grid } = await mount(); await customize(host)
    grid.style.gridTemplateColumns = '848px'
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => { pointer(handle, 'pointerdown', 200, 264); pointer(handle, 'pointermove', 200, 544) })
    await act(async () => pointer(handle, 'pointerup', 200, 544))
    expect(readLayout()[0]).toEqual(['today', 1, 544])
  })

  it('adapts the visible body during resize preview and restores it on cancellation', async () => {
    saveLayout([['today', 1, 264]])
    client.tasks.mockResolvedValue(tasks(12))
    const { host, grid } = await mount(); await customize(host)
    const card = grid.querySelector('[data-widget-id="today"]')!
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
    await act(async () => { pointer(handle, 'pointerdown', 200, 264); pointer(handle, 'pointermove', 480, 544) })
    expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(12)
    expect(readLayout()).toEqual([['today', 1, 264]])
    await act(async () => pointer(handle, 'pointercancel', 480, 544))
    expect(card.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
  })

  it('locks editing controls and does not move or save when dragging a heading', async () => {
    const { host, grid } = await mount()
    for (const label of ['Move Today', 'Resize Today', 'Remove Today', 'Size of Today']) expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull()
    const heading = grid.querySelector('[data-widget-id="today"] [data-widget-heading]')!
    await act(async () => { pointer(heading, 'pointerdown', 15, 25); pointer(heading, 'pointermove', 300, 100); pointer(heading, 'pointerup', 300, 100) })
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['today', 'focus'])
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    await customize(host)
    for (const label of ['Move Today', 'Resize Today', 'Remove Today']) expect(host.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
  })

  it('moves a widget by pointer in Customize and persists the order', async () => {
    const { host, grid } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Move Today"]')!
    await act(async () => pointer(handle, 'pointerdown', 15, 25))
    await act(async () => pointer(handle, 'pointermove', 300, 100))
    expect(grid.children[1]?.hasAttribute('data-drop-target')).toBe(true)
    await act(async () => pointer(handle, 'pointerup', 300, 100))
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['focus', 'today'])
    expect(readLayout().slice(0, 2).map(([id]) => id)).toEqual(['focus', 'today'])
  })

  it('snaps pointer resize to a size and restores it after remount', async () => {
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['today', 1, 264], ['cal', 2, 264]]))
    const { host, grid } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => pointer(resize, 'pointerdown', 200, 264))
    await act(async () => pointer(resize, 'pointermove', 410, 318))
    await act(async () => pointer(resize, 'pointerup', 410, 318))
    expect(readLayout()[0]).toEqual(['today', 2, 264])
    expect((grid.children[0] as HTMLElement).dataset.sizeKey).toBe('M')
    await act(async () => root!.unmount()); root = undefined
    const restored = await mount()
    expect((restored.grid.children[0] as HTMLElement).style.getPropertyValue('--widget-span')).toBe('2')
  })

  it('snaps a large diagonal pointer resize to L', async () => {
    const { host } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    await act(async () => pointer(resize, 'pointerdown', 200, 264))
    await act(async () => pointer(resize, 'pointermove', 410, 688))
    await act(async () => pointer(resize, 'pointerup', 410, 688))
    expect(readLayout()[0]).toEqual(['today', 2, 544])
  })

  it('offers preset sizes and button and keyboard alternatives for reordering', async () => {
    const { host } = await mount(); await customize(host)
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Size of Today"]')!
    expect([...select.options].map((option) => option.textContent)).toEqual(['S', 'M', 'L', 'Tall'])
    for (const { id: value, span, height } of WIDGET_SIZES) {
      await choose(select, value)
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
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.includes('Today'))!)
    expect(grid.querySelector('[data-widget-id="today"]')).not.toBeNull()
    expect(readLayout().find(([id]) => id === 'today')).toEqual(['today', 2, 264])
    await click(button(host, 'Done'))
    expect(host.querySelector('[aria-label="Remove Today"]')).toBeNull()
  })

  it('lets the same widget be added twice with unique keys', async () => {
    const { host, grid } = await mount(); await customize(host)
    await click(button(host, 'Widget'))
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.includes('Calendar'))!)
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-widget-id="cal"]')]
    expect(cards).toHaveLength(2)
    expect(new Set(cards.map(card => card.dataset.widgetKey)).size).toBe(2)
    await click(cards[1].querySelector<HTMLButtonElement>('[aria-label="Remove Calendar"]')!)
    expect(grid.querySelectorAll('[data-widget-id="cal"]')).toHaveLength(1)
  })

  it('cancels pointer resize on pointercancel, Escape and lost capture', async () => {
    const { host, grid } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    const card = grid.children[0] as HTMLElement
    await act(async () => { pointer(resize, 'pointerdown', 200, 264); pointer(resize, 'pointermove', 410, 688) })
    await act(async () => pointer(resize, 'pointercancel', 410, 688))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect(card.dataset.sizeKey).toBe('M')
    await act(async () => { pointer(resize, 'pointerdown', 200, 264); pointer(resize, 'pointermove', 410, 688) })
    await act(async () => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => pointer(resize, 'pointerup', 410, 688))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    await act(async () => { pointer(resize, 'pointerdown', 200, 264); pointer(resize, 'pointermove', 410, 688) })
    await act(async () => pointer(resize, 'lostpointercapture', 410, 688))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect(card.dataset.sizeKey).toBe('M')
  })

  it('Done cancels a gesture and removes editing affordances', async () => {
    const { host, grid } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Move Today"]')!
    await act(async () => { pointer(handle, 'pointerdown', 15, 25); pointer(handle, 'pointermove', 300, 100) })
    await click(button(host, 'Done'))
    for (const label of ['Move Today', 'Resize Today', 'Remove Today', 'Size of Today']) expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull()
    expect(grid.querySelector('[data-drop-target]')).toBeNull()
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['today', 'focus'])
  })

  it('reports a blocked local save instead of claiming the layout is durable', async () => {
    const { host } = await mount(); await customize(host)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded') })
    await choose(host.querySelector<HTMLSelectElement>('[aria-label="Size of Today"]')!, '2x2')
    expect(host.textContent).toContain('Could not save the layout')
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })
})
