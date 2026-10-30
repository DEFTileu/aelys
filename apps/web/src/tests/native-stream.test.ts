import { describe, expect, it, vi } from 'vitest'
import { createNativeFetch } from '../lib/nativeClient'
import { createNativeTransport, type NativeAIStreamMessage, type NativeInvoke } from '../lib/nativeTransport'

const origin = 'http://127.0.0.1:8000'
const eventsUrl = `${origin}/api/v1/ai/runs/run-1/events`

function fixture(autoOpen = true) {
  let receive!: (message: NativeAIStreamMessage) => void
  let finishInvocation!: () => void
  const channel = {}
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'native_ai_events') {
      expect(args?.onEvent).toBe(channel)
      if (autoOpen) receive({ type: 'opened' })
      await new Promise<void>((resolve) => { finishInvocation = resolve })
    }
  })
  const transport = createNativeTransport(invoke as NativeInvoke, (callback) => { receive = callback; return channel })
  return {
    fetcher: createNativeFetch(transport, origin), invoke,
    emit: (message: NativeAIStreamMessage) => receive(message),
    finishInvocation: () => finishInvocation(),
  }
}

describe('native AI Channel stream', () => {
  it('delivers text before invoke completes and closes only on the ordered end message', async () => {
    const test = fixture()
    const response = await test.fetcher(eventsUrl)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    test.emit({ type: 'event', event: { id: '1', event: 'ai.text.delta', data: { text: 'Привет 🌙' } } })
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('Привет 🌙')
    let closed = false
    const next = reader.read().then((value) => { closed = true; return value })
    test.finishInvocation()
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    test.emit({ type: 'end' })
    expect((await next).done).toBe(true)
    expect(test.invoke).toHaveBeenCalledTimes(1)
    expect(test.invoke).toHaveBeenCalledWith('native_ai_events', expect.objectContaining({ origin, id: 'run-1', requestId: expect.any(String) }))
  })

  it('closes the exact native subscription on AbortSignal and ignores late messages', async () => {
    const test = fixture()
    const abort = new AbortController()
    const response = await test.fetcher(eventsUrl, { signal: abort.signal })
    const reader = response.body!.getReader()
    const rejected = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    const requestId = test.invoke.mock.calls[0][1]!.requestId
    expect(test.invoke).toHaveBeenCalledWith('native_ai_events_close', { origin, requestId })
    test.emit({ type: 'event', event: { id: null, event: 'ai.text.delta', data: { text: 'late' } } })
    test.emit({ type: 'end' })
    test.finishInvocation()
  })

  it('closes an early-aborted request once registration is acknowledged', async () => {
    const test = fixture(false)
    const abort = new AbortController()
    const pending = test.fetcher(eventsUrl, { signal: abort.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    expect(test.invoke).toHaveBeenCalledTimes(1)
    test.emit({ type: 'opened' })
    expect(test.invoke).toHaveBeenCalledWith('native_ai_events_close', expect.objectContaining({ origin }))
    test.finishInvocation()
  })

  it('does not start an already-aborted request', async () => {
    const test = fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(test.fetcher(eventsUrl, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(test.invoke).not.toHaveBeenCalled()
  })

  it('closes the subscription when the reader cancels', async () => {
    const test = fixture()
    const response = await test.fetcher(eventsUrl)
    await response.body!.cancel()
    expect(test.invoke).toHaveBeenCalledWith('native_ai_events_close', expect.objectContaining({ origin }))
    test.finishInvocation()
  })

  it('surfaces a midstream native error without reporting successful completion', async () => {
    const test = fixture()
    const response = await test.fetcher(eventsUrl)
    const rejected = expect(response.body!.getReader().read()).rejects.toThrow('NETWORK_ERROR')
    test.emit({ type: 'error', code: 'NETWORK_ERROR' })
    await rejected
    test.finishInvocation()
  })
})
