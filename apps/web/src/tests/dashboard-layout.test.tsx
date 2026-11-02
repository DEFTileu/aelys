import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'
import { HOME_LAYOUT_KEY, WIDGET_SIZES, WIDGET_IDS, saveLayout, readLayout } from '../views/desktop/homeLayout'

const client = vi.hoisted(() => ({ tasks: vi.fn(), calendarOccurrences: vi.fn(), projects: vi.fn(), notes: vi.fn(), financeTransactions: vi.fn(), financeBudgets: vi.fn(), focusSessions: vi.fn(), resumeFocusSession: vi.fn(), mailMessages: vi.fn(), activity: vi.fn(), createTask: vi.fn() }))
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
    expect([...grid.children].map(card => [card.getAttribute('data-widget-id'), (card as HTMLElement).dataset.sizeKey])).toEqual([['today', 'S'], ['cal', 'S'], ['focus', 'S'], ['weather', 'S'], ['proj', 'S'], ['notes', 'S'], ['fin', 'S'], ['kb', 'S'], ['activity', 'Full']])
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })

  it('does not grow a card with its record count: Today S always shows at most five tasks', async () => {
    client.tasks.mockResolvedValue(tasks(12))
    const { grid } = await mount()
    expect(grid.querySelector('[data-widget-id="today"]')!.querySelectorAll('[role="checkbox"]')).toHaveLength(5)
  })

  it.each(WIDGET_IDS.filter(id => id !== 'weather'))('renders %s at S, M and L, with L adding content', async (id) => {
    const at = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString()
    const records = Array.from({ length: 12 }, (_, index) => ({ id: `record-${index}`, title: `Record ${index}`, name: `Project ${index}`, status: 'todo', due_at: at(index), starts_at: at(index + 1), ends_at: at(index + 1.5), markdown_body: 'Note preview', currency: 'KZT', amount: '1.5', type: index % 2 ? 'expense' : 'income', category_name: `Category ${index}`, is_read: false, pinned: index === 1, occurred_at: at(-index), notes: '', sender: 'Sender', subject: 'Subject', body: 'Body', received_at: at(-index), event_kind: 'task.created', actor_kind: 'owner', project_id: null, elapsed_seconds: 60 }))
    Object.entries(client).forEach(([key, method]) => method.mockResolvedValue(key === 'focusSessions' ? [] : key === 'createTask' ? {} : records))
    const html: string[] = []
    for (const [span, height] of [[1, 264], [2, 264], [2, 544]]) {
      saveLayout([[id, span, height]])
      const { grid } = await mount()
      html.push(grid.querySelector('.home-widget-body')!.innerHTML)
      await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    }
    // S and M share one layout in the design (the card is just wider); L adds rows or extras.
    expect(html.every(markup => markup.length > 0)).toBe(true)
    expect(html[2]).not.toBe(html[0])
  })

  it('shows one muted line plus one action when empty, and Can’t load · Retry when loading fails', async () => {
    const { grid } = await mount()
    const empty = grid.querySelector('[data-widget-id="proj"] .dw-empty')!
    expect(empty.textContent).toContain('No projects yet.')
    expect(empty.querySelectorAll('button')).toHaveLength(1)
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    client.projects.mockRejectedValue(new Error('offline'))
    const failed = await mount()
    const retry = failed.grid.querySelector('[data-widget-id="proj"] .dw-empty')!
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
    expect(text).toContain('15\u00A0₸')
    expect(text).not.toContain('115')
    expect(text).not.toContain('$')
    expect(text).toContain('1 more currency')
  })

  it('Finances L shows categories and one budget row only in the budget currency', async () => {
    saveLayout([['fin', 2, 544]])
    const now = Date.now()
    const tx = (id: string, currency: string, amount: string, name: string | null) => ({ id, currency, amount, type: 'expense', category_id: name ? 'c1' : null, category_name: name, occurred_at: new Date(now).toISOString(), notes: '' })
    client.financeTransactions.mockResolvedValue([tx('a', 'KZT', '-10', 'Food'), tx('b', 'KZT', '-5', 'Food'), tx('c', 'KZT', '-2', null), tx('d', 'USD', '-100', 'Travel')])
    const budget = (currency: string, limit: string) => ({ id: 'b', category_id: null, currency, period_start: new Date(now - 86400000).toISOString(), period_end: new Date(now + 86400000).toISOString(), limit_amount: limit })
    client.financeBudgets.mockResolvedValue([budget('USD', '500')])
    const none = await mount()
    expect(none.grid.querySelector('[data-widget-id="fin"]')!.textContent).toContain('Food'); expect(none.grid.querySelector('[data-widget-id="fin"]')!.textContent).not.toContain('Travel'); expect(none.grid.querySelector('[data-widget-id="fin"]')!.textContent).not.toContain('Budget')
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    client.financeBudgets.mockResolvedValue([budget('KZT', '100')])
    const withBudget = await mount()
    const text = withBudget.grid.querySelector('[data-widget-id="fin"]')!.textContent!
    expect(text).toContain('Uncategorized'); expect(text).toContain('15\u00A0₸'); expect(text).toContain('Budget17\u00A0₸ / 100\u00A0₸'); expect(text).not.toContain('Travel')
  })

  it('Mail counts only unread messages and shows Inbox is clear with Import otherwise', async () => {
    const message = (id: string, is_read: boolean) => ({ id, sender: `Sender ${id}`, subject: `Subject ${id}`, body: 'b', received_at: new Date().toISOString(), is_read })
    saveLayout([['mail', 1, 264]])
    client.mailMessages.mockResolvedValue([message('1', false), message('2', true), message('3', false)])
    const unread = await mount()
    const mailCard = unread.grid.querySelector('[data-widget-id="mail"]')!
    expect(mailCard.querySelector('.dw-head-badge')?.textContent).toBe('2')
    expect(mailCard.querySelectorAll('.dw-row')).toHaveLength(2)
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    client.mailMessages.mockResolvedValue([message('2', true)])
    const clear = await mount()
    const empty = clear.grid.querySelector('[data-widget-id="mail"] .dw-empty')!
    expect(empty.textContent).toContain('Inbox is clear'); expect(empty.textContent).toContain('Import'); expect(empty.querySelectorAll('button')).toHaveLength(1)
  })

  it('Notes L shows the pinned note first', async () => {
    saveLayout([['notes', 2, 544]])
    client.notes.mockResolvedValue([{ id: 'n1', title: 'Recent one', markdown_body: 'x', updated_at: '2026-10-30T10:00:00Z' }, { id: 'n2', title: 'Pinned one', markdown_body: 'y', pinned: true, updated_at: '2026-01-01T10:00:00Z' }])
    const { grid } = await mount()
    const text = grid.querySelector('[data-widget-id="notes"]')!.textContent!
    expect(text.indexOf('Pinned one')).toBeGreaterThanOrEqual(0); expect(text.indexOf('Pinned one')).toBeLessThan(text.indexOf('Recent one'))
  })

  it('Focus shows a paused session as Resume and the toggle calls resume', async () => {
    saveLayout([['focus', 2, 264]])
    client.focusSessions.mockResolvedValue([{ id: 'f1', version: 4, status: 'paused', mode: 'pomodoro', started_at: new Date(Date.now() - 600_000).toISOString(), elapsed_seconds: 125, paused_seconds: 300, task_id: null }])
    client.resumeFocusSession.mockResolvedValue({})
    const { grid } = await mount()
    const card = grid.querySelector('[data-widget-id="focus"]')!
    expect(card.textContent).toContain('02:05'); expect(card.textContent).toContain('Paused')
    await click(card.querySelector<HTMLElement>('[aria-label="Resume focus"]')!)
    expect(client.resumeFocusSession).toHaveBeenCalledWith('f1', 4)
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

const press = async (node: Element, key: string, shiftKey = false) => act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })) })
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!

describe('dashboard customization', () => {
  it('has no arrow buttons, size dropdown or edit tools on the card', async () => {
    const { host, grid } = await mount(); await customize(host)
    expect(grid.querySelector('select, .home-widget-edit-tools, [aria-label$="earlier"], [aria-label$="later"], [aria-label^="Move"]')).toBeNull()
    expect(host.querySelector('[aria-label="Remove Today"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Resize Today"]')).not.toBeNull()
  })

  it('disables card bodies while editing', async () => {
    const { host, grid } = await mount()
    expect(grid.querySelector('.home-widget-body[inert]')).toBeNull()
    await customize(host)
    const bodies = [...grid.querySelectorAll('.home-widget-body')]
    expect(bodies.length).toBe(9)
    expect(bodies.every(body => body.hasAttribute('inert'))).toBe(true)
    expect(grid.classList.contains('home-widget-grid--editing')).toBe(true)
  })

  it('moves with arrows, resizes with Shift+arrows through S, M, L and Tall, and removes with Delete', async () => {
    const { host } = await mount(); await customize(host)
    expect(card(host, 'today').tabIndex).toBe(0)
    await press(card(host, 'today'), 'ArrowRight')
    expect(readLayout().slice(0, 2).map(([id]) => id)).toEqual(['cal', 'today'])
    await press(card(host, 'today'), 'ArrowLeft')
    expect(readLayout()[0][0]).toBe('today')
    for (const [key, span, height] of [['ArrowDown', 1, 544], ['ArrowLeft', 1, 544], ['ArrowUp', 1, 264], ['ArrowRight', 2, 264]] as const) {
      await press(card(host, 'today'), key, true)
      expect(readLayout()[0]).toEqual(['today', span, height])
    }
    await press(card(host, 'today'), 'Delete')
    expect(card(host, 'today')).toBeNull()
    expect(readLayout().some(([id]) => id === 'today')).toBe(false)
  })

  it('saves all four sizes for every widget', async () => {
    saveLayout(WIDGET_IDS.map(id => [id, 1, 264]))
    const { host } = await mount(); await customize(host)
    for (const id of WIDGET_IDS) {
      for (const [key, size] of [['ArrowRight', WIDGET_SIZES[1]], ['ArrowDown', WIDGET_SIZES[2]], ['ArrowLeft', WIDGET_SIZES[3]], ['ArrowUp', WIDGET_SIZES[0]]] as const) {
        await press(card(host, id), key, true)
        expect(card(host, id).dataset.size).toBe(size.id)
        expect(card(host, id).dataset.rows).toBe(String(size.rows))
        expect(readLayout().find(([entry]) => entry === id)).toEqual([id, size.span, size.height])
      }
    }
  })

  it('snaps resize-handle keyboard input to S, M, L and Tall', async () => {
    const { host } = await mount(); await customize(host)
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    for (const [key, span, height] of [['ArrowDown', 1, 544], ['ArrowLeft', 1, 544], ['ArrowUp', 1, 264], ['ArrowRight', 2, 264]] as const) {
      await press(handle, key)
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

  it('adapts the visible body and shows a size badge during resize preview, then restores on cancellation', async () => {
    saveLayout([['today', 1, 264]])
    client.tasks.mockResolvedValue(tasks(12))
    const { host } = await mount(); await customize(host)
    const today = card(host, 'today')
    const handle = host.querySelector('[aria-label="Resize Today"]')!
    expect(today.querySelectorAll('[role="checkbox"]')).toHaveLength(5)
    await act(async () => { pointer(handle, 'pointerdown', 200, 264); pointer(handle, 'pointermove', 480, 544) })
    expect(today.querySelectorAll('[role="checkbox"]')).toHaveLength(11)
    expect(today.querySelector('.home-size-badge')?.textContent).toBe('2 × 2')
    expect(readLayout()).toEqual([['today', 1, 264]])
    await act(async () => pointer(handle, 'pointercancel', 480, 544))
    expect(today.querySelectorAll('[role="checkbox"]')).toHaveLength(5)
    expect(today.querySelector('.home-size-badge')).toBeNull()
  })

  it('does not move or save when dragging outside editing mode', async () => {
    const { host, grid } = await mount()
    for (const label of ['Resize Today', 'Remove Today']) expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull()
    const heading = grid.querySelector('[data-widget-id="today"] [data-widget-heading]')!
    await act(async () => { pointer(heading, 'pointerdown', 15, 25); pointer(heading, 'pointermove', 300, 100); pointer(heading, 'pointerup', 300, 100) })
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['today', 'cal'])
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })

  it('moves a widget by dragging the card body, with a dashed drop target, and persists the order', async () => {
    const { host, grid } = await mount(); await customize(host)
    const today = card(host, 'today')
    await act(async () => pointer(today, 'pointerdown', 15, 25))
    await act(async () => pointer(today, 'pointermove', 300, 100))
    expect(grid.children[1]?.hasAttribute('data-drop-target')).toBe(true)
    await act(async () => pointer(today, 'pointerup', 300, 100))
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['cal', 'today'])
    expect(readLayout().slice(0, 2).map(([id]) => id)).toEqual(['cal', 'today'])
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

  it('removes a card with the remove badge and adds it back from the Add widget sheet', async () => {
    const { host, grid } = await mount(); await customize(host)
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Remove Today"]')!)
    expect(grid.querySelector('[data-widget-id="today"]')).toBeNull()
    expect(readLayout().some(([id]) => id === 'today')).toBe(false)
    await click(button(host, 'Widget'))
    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Add widget"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('M')
    await click([...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent?.includes('Today'))!)
    await click([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Add')!)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(readLayout().at(-1)).toEqual(['today', 2, 264])
    expect(card(host, 'today').hasAttribute('data-new')).toBe(true)
    await click(button(host, 'Done'))
    expect(host.querySelector('[aria-label="Remove Today"]')).toBeNull()
  })

  it('lets the same widget be added twice at different sizes with unique keys', async () => {
    const { host, grid } = await mount(); await customize(host)
    await click(button(host, 'Widget'))
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!
    expect([...dialog.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes('Calendar'))?.textContent).toContain('On Home')
    await click([...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent?.includes('Calendar'))!)
    await click([...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(node => node.textContent === 'L')!)
    await click([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Add')!)
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-widget-id="cal"]')]
    expect(cards.map(node => node.dataset.sizeKey)).toEqual(['S', 'L'])
    expect(new Set(cards.map(node => node.dataset.widgetKey)).size).toBe(2)
    expect(readLayout().filter(([id]) => id === 'cal')).toHaveLength(2)
    await click(cards[1].querySelector<HTMLButtonElement>('[aria-label="Remove Calendar"]')!)
    expect(grid.querySelectorAll('[data-widget-id="cal"]')).toHaveLength(1)
  })

  it('filters the Add widget list by search and closes with Cancel or Escape without changing the layout', async () => {
    const { host } = await mount(); await customize(host)
    await click(button(host, 'Widget'))
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search widgets"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'mail'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect([...host.querySelectorAll('[role="option"]')].map(node => node.textContent)).toEqual(['Mail'])
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === 'Cancel')!)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click(button(host, 'Widget'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[aria-label="Remove Today"]')).not.toBeNull()
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })

  it('leaves edit mode with Escape', async () => {
    const { host } = await mount(); await customize(host)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('[aria-label="Remove Today"]')).toBeNull()
  })

  it('cancels pointer resize on pointercancel, Escape and lost capture', async () => {
    const { host, grid } = await mount(); await customize(host)
    const resize = host.querySelector('[aria-label="Resize Today"]')!
    const today = grid.children[0] as HTMLElement
    await act(async () => { pointer(resize, 'pointerdown', 200, 264); pointer(resize, 'pointermove', 410, 688) })
    await act(async () => pointer(resize, 'pointercancel', 410, 688))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect(today.dataset.sizeKey).toBe('S')
    await act(async () => { pointer(resize, 'pointerdown', 200, 264); pointer(resize, 'pointermove', 410, 688) })
    await press(resize, 'Escape')
    await act(async () => pointer(resize, 'pointerup', 410, 688))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    await act(async () => { pointer(resize, 'pointerdown', 200, 264); pointer(resize, 'pointermove', 410, 688) })
    await act(async () => pointer(resize, 'lostpointercapture', 410, 688))
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect(today.dataset.sizeKey).toBe('S')
  })

  it('Done cancels a gesture and removes editing affordances', async () => {
    const { host, grid } = await mount(); await customize(host)
    const today = card(host, 'today')
    await act(async () => { pointer(today, 'pointerdown', 15, 25); pointer(today, 'pointermove', 300, 100) })
    await click(button(host, 'Done'))
    for (const label of ['Resize Today', 'Remove Today']) expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull()
    expect(grid.querySelector('[data-drop-target]')).toBeNull()
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
    expect([...grid.children].slice(0, 2).map((item) => item.getAttribute('data-widget-id'))).toEqual(['today', 'cal'])
  })

  it('reports a blocked local save instead of claiming the layout is durable', async () => {
    const { host } = await mount(); await customize(host)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded') })
    await press(card(host, 'today'), 'ArrowDown', true)
    expect(host.textContent).toContain('Could not save the layout')
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).toBeNull()
  })

  it('opens Customize on mobile with a long press on the widget heading', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', addEventListener() {}, removeEventListener() {} }))
    try {
      const { host } = await mount()
      const heading = card(host, 'today').querySelector<HTMLElement>('[data-widget-heading]')!
      await act(async () => pointer(heading, 'pointerdown', 15, 25))
      await act(async () => { vi.advanceTimersByTime(600) })
      expect(window.location.pathname).toBe('/widgets')
    } finally { vi.useRealTimers(); window.history.replaceState({}, '', '/') }
  })
})
