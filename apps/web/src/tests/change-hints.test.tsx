import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_COLLECTIONS, CHANGES_EVENT, FALLBACK_POLL_MS, onChangeHint, startChangeHints } from '../lib/changeHints'
import { TimerView } from '../views/TimerView'

const client = vi.hoisted(() => ({ focusSessions: vi.fn(), tasks: vi.fn(), projects: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

/** An SSE response that stays open until the test closes it. */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const send = (text: string) => controller.enqueue(new TextEncoder().encode(text))
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), send, close: () => controller.close() }
}
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); document.body.innerHTML = '' })

describe('change hint stream', () => {
  it('reports each hint and does not poll while the stream is live', async () => {
    vi.useFakeTimers()
    const stream = openStream()
    const onHint = vi.fn()
    stop = startChangeHints(async () => stream.response, onHint)
    await flush()
    stream.send(': ready\n\nevent: changes.hint\ndata: {"collections":["focus"]}\n\n')
    await flush()
    expect(onHint).toHaveBeenCalledExactlyOnceWith(['focus'])
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 2)
    expect(onHint).toHaveBeenCalledTimes(1)
  })

  it('falls back to the 30 s poll while the stream cannot open, and catches up once it reconnects', async () => {
    vi.useFakeTimers()
    const stream = openStream()
    const open = vi.fn().mockRejectedValue(new Error('offline'))
    const onHint = vi.fn()
    stop = startChangeHints(open, onHint)
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS)
    expect(onHint).toHaveBeenCalledWith(ALL_COLLECTIONS)
    const polls = onHint.mock.calls.length
    open.mockResolvedValue(stream.response)
    await vi.advanceTimersByTimeAsync(32_000)  // the capped retry delay
    expect(onHint).toHaveBeenCalledTimes(polls + 2)  // one more poll tick, then the catch-up on reconnect
    expect(onHint).toHaveBeenLastCalledWith(ALL_COLLECTIONS)
    onHint.mockClear()
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS)
    expect(onHint).not.toHaveBeenCalled()
  })

  it('reopens a stream the server ended normally without a catch-up refetch', async () => {
    vi.useFakeTimers()
    const first = openStream(), second = openStream()
    const open = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    const onHint = vi.fn()
    stop = startChangeHints(open, onHint)
    await vi.advanceTimersByTimeAsync(240_000)
    first.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(open).toHaveBeenCalledTimes(2)
    expect(onHint).not.toHaveBeenCalled()
  })

  it('stops polling and reconnecting once stopped', async () => {
    vi.useFakeTimers()
    const open = vi.fn().mockRejectedValue(new Error('offline'))
    const onHint = vi.fn()
    startChangeHints(open, onHint)()
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 3)
    expect(onHint).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('wakes only listeners for the named collections', () => {
    const focus = vi.fn(), tasks = vi.fn()
    const stops = [onChangeHint(['focus'], focus), onChangeHint(['tasks'], tasks)]
    window.dispatchEvent(new CustomEvent(CHANGES_EVENT, { detail: ['focus'] }))
    stops.forEach((item) => item())
    window.dispatchEvent(new CustomEvent(CHANGES_EVENT, { detail: ['focus', 'tasks'] }))
    expect(focus).toHaveBeenCalledTimes(1)
    expect(tasks).not.toHaveBeenCalled()
  })
})

describe('views on a hint', () => {
  it('shows a focus session started on the board after a focus hint', async () => {
    window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
    client.focusSessions.mockResolvedValue([]); client.tasks.mockResolvedValue([]); client.projects.mockResolvedValue([])
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => root.render(<TimerView apiStatus="ready" />))
    expect(client.focusSessions).toHaveBeenCalledTimes(1)
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Start')).toBe(true)
    client.focusSessions.mockResolvedValue([{ id: 'board', version: 1, started_at: new Date().toISOString(), mode: 'pomodoro', status: 'active', elapsed_seconds: 0, paused_seconds: 0, task_id: null, project_id: null }])
    await act(async () => { window.dispatchEvent(new CustomEvent(CHANGES_EVENT, { detail: ['focus'] })) })
    expect(client.focusSessions).toHaveBeenLastCalledWith({ forceRefresh: true })
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Start')).toBe(false)
    act(() => root.unmount())
  })
})
