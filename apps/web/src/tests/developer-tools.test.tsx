import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeveloperLogo } from '../components/DeveloperLogo'
import { diagnostics } from '../lib/diagnostics'
import { createNativeFetch } from '../lib/nativeClient'
import { createNativeTransport, type NativeInvoke } from '../lib/nativeTransport'

afterEach(() => { diagnostics.setEnabled(false); document.body.innerHTML = '' })

describe('local developer diagnostics', () => {
  it('opens after ten logo presses and clears captured data when switched off', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<DeveloperLogo />))
    const logo = host.querySelector<HTMLButtonElement>('button[aria-label="Aelys"]')!
    await act(async () => { for (let i = 0; i < 9; i++) logo.click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => logo.click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    act(() => { diagnostics.begin('POST', '/api/v1/ai/runs', { message: 'visible text', api_key: 'secret-value', nested: { refresh_token: 'refresh-value' } }) })
    expect(document.body.textContent).toContain('visible text')
    expect(document.body.textContent).not.toContain('secret-value')
    expect(document.body.textContent).not.toContain('refresh-value')
    await act(async () => toggle.click())
    expect(diagnostics.getSnapshot().entries).toHaveLength(0)
    await act(async () => root.unmount())
  })
  it('shows the real native HTTP status even when the bridge rejects the response', async () => {
    diagnostics.setEnabled(true)
    let channel: ((v: { http_status: number; cost_estimate?: number }) => void) | undefined
    const invoke = vi.fn(async () => { channel?.({ http_status: 200, cost_estimate: 0 }); throw 'MUTATION_OUTCOME_UNKNOWN' }) as NativeInvoke
    const transport = createNativeTransport(invoke, undefined, receive => { channel = receive; return {} })
    const fetcher = createNativeFetch(transport, 'https://example.test')
    const response = await fetcher('https://example.test/api/v1/ai/runs', { method: 'POST', body: JSON.stringify({ message: 'private', api_key: 'secret' }) })
    expect(response.status).toBe(502)
    const entry = diagnostics.getSnapshot().entries[0]
    expect(entry.native).toEqual({ http_status: 200, cost_estimate: 0 })
    expect(entry.result).toBe('MUTATION_OUTCOME_UNKNOWN')
    expect(entry.request).toEqual({ message: 'private', api_key: '[скрыто]' })
  })
  it('records response bodies without credentials and keeps usage fields', async () => {
    diagnostics.setEnabled(true)
    const invoke = vi.fn(async () => ({ id: 'run-1', access_token: 'access-value', token_counts: { input: 3 } })) as NativeInvoke
    const fetcher = createNativeFetch(createNativeTransport(invoke), 'https://example.test')
    await fetcher('https://example.test/api/v1/ai/conversations', { method: 'POST', body: JSON.stringify({ title: 'Hi' }) })
    const entry = diagnostics.getSnapshot().entries[0]
    expect(entry.request).toEqual({ title: 'Hi' })
    expect(entry.response).toEqual({ id: 'run-1', access_token: '[скрыто]', token_counts: { input: 3 } })
  })
  it('records every AI stream event in order', async () => {
    diagnostics.setEnabled(true)
    let receive: ((message: unknown) => void) | undefined
    const invoke = vi.fn(async () => {
      receive?.({ type: 'opened' })
      receive?.({ type: 'event', event: { id: '1', event: 'ai.run.failed', data: { code: 'AI_ERROR', message: 'Provider execution failed' } } })
      receive?.({ type: 'end' })
    }) as NativeInvoke
    const transport = createNativeTransport(invoke, callback => { receive = callback as (message: unknown) => void; return {} })
    const response = await createNativeFetch(transport, 'https://example.test')('https://example.test/api/v1/ai/runs/run-1/events')
    await response.text()
    const entry = diagnostics.getSnapshot().entries[0]
    expect(entry.events).toEqual([{ event: 'ai.run.failed', data: { code: 'AI_ERROR', message: 'Provider execution failed' } }])
    expect(entry.result).toBe('stream end')
  })
})
