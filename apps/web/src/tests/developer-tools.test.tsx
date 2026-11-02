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
    act(() => { diagnostics.begin('POST', '/api/v1/ai/runs', { message: 'private text', api_key: 'secret-value' }) })
    expect(document.body.textContent).not.toContain('private text')
    expect(document.body.textContent).not.toContain('secret-value')
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
    expect(JSON.stringify(entry)).not.toMatch(/private|secret/)
  })
})
