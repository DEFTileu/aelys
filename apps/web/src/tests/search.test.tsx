import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../components/CommandPalette'
import { SearchView } from '../views/SearchView'

const client = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(element)) }
async function input(value: string) { const field = host.querySelector('input')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(220) }) }
function key(key: string, options: KeyboardEventInit = {}) { host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...options })) }
function clickText(text: string) { [...host.querySelectorAll('button')].find(button => button.textContent?.includes(text))!.click() }

afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; history.replaceState({}, '', '/'); vi.resetAllMocks(); vi.useRealTimers() })

describe('search surfaces', () => {
  it('discards stale search responses, filters supported results and opens the selected entity', async () => {
    vi.useFakeTimers()
    let resolveOld!: (value: unknown) => void
    client.search.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })).mockResolvedValueOnce({ results: [{ kind: 'note', id: 'note /1', title: 'Current note' }, { kind: 'task', id: 't1', title: 'Current task' }, { kind: 'unknown', id: 'x', title: 'Unsupported' }] })
    await mount(<SearchView apiStatus="ready" />)
    await input('old'); await tick(); await input('current'); await tick()
    await act(async () => resolveOld({ results: [{ kind: 'note', id: 'old', title: 'Stale result' }] }))
    expect(host.textContent).toContain('Current note'); expect(host.textContent).not.toContain('Stale result'); expect(host.textContent).not.toContain('Unsupported')
    await act(async () => clickText('Notes'))
    expect(host.textContent).toContain('Current note'); expect(host.textContent).not.toContain('Current task')
    await act(async () => clickText('Current note'))
    expect(location.pathname + location.search).toBe('/notes?note=note%20%2F1')
  })
  it('uses keyboard selection, restores focus, and sends creation intent', async () => {
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus()
    const close = vi.fn(); const navigate = vi.fn()
    await mount(<CommandPalette onClose={close} onNavigate={navigate} />)
    await act(async () => key('ArrowDown'))
    await act(async () => key('Enter'))
    expect(navigate).toHaveBeenCalledWith('/ai')
    await input('new task')
    await act(async () => key('Enter'))
    expect(location.pathname + location.search).toBe('/tasks?create=1')
    await act(async () => key('Escape'))
    expect(close).toHaveBeenCalled()
    act(() => root!.unmount()); root = undefined
    expect(document.activeElement).toBe(trigger)
  })
  it('sends note and calendar creation intents and opens mail results', async () => {
    vi.useFakeTimers(); client.search.mockResolvedValue({ results: [{ kind: 'mail', id: 'm/1', title: 'Budget mail' }] })
    await mount(<CommandPalette onClose={() => {}} onNavigate={() => {}} />)
    await input('new note'); await act(async () => key('Enter'))
    expect(location.pathname + location.search).toBe('/notes?create=1')
    await input('create event'); await act(async () => key('Enter'))
    expect(location.pathname + location.search).toBe('/calendar?create=1')
    await input('budget'); await tick(); await act(async () => key('Enter'))
    expect(location.pathname + location.search).toBe('/mail?mail=m%2F1')
  })
  it('shows live result preview and opens the matching task', async () => {
    vi.useFakeTimers(); client.search.mockResolvedValue({ results: [{ kind: 'task', id: 'task-1', title: 'Review budget' }] })
    await mount(<CommandPalette onClose={() => {}} onNavigate={() => {}} />)
    await input('budget'); await tick()
    expect(host.querySelector('.actual-palette__preview')?.textContent).toContain('Review budget')
    await act(async () => key('Enter'))
    expect(location.pathname + location.search).toBe('/tasks?task=task-1')
  })
  it('traps tab focus inside the palette', async () => {
    await mount(<CommandPalette onClose={() => {}} onNavigate={() => {}} />)
    const inputEl = host.querySelector('input')!
    await act(async () => key('Tab', { shiftKey: true }))
    expect(document.activeElement).toBe(host.querySelector('.actual-palette__preview button'))
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' })) })
    expect(document.activeElement).toBe(inputEl)
  })
})
