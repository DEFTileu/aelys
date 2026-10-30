import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderSettings } from '../views/ProviderSettings'

const client = vi.hoisted(() => ({ aiProviders: vi.fn(), createAIProvider: vi.fn(), setAIProviderSecret: vi.fn(), updateAIProvider: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

describe('provider settings form', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.resetAllMocks() })

  it('retains a newly created provider for retry and clears a failed key', async () => {
    client.aiProviders.mockResolvedValue([])
    client.createAIProvider.mockResolvedValue({ id: 'new-provider' })
    client.setAIProviderSecret.mockRejectedValueOnce(new Error('secret must not be shown')).mockResolvedValueOnce(undefined)
    client.updateAIProvider.mockResolvedValue(undefined)
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<ProviderSettings />))
    const setValue = async (field: HTMLInputElement, value: string) => {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    const model = host.querySelector<HTMLInputElement>('input:not([type=password])')!
    const key = host.querySelector<HTMLInputElement>('input[type=password]')!
    await setValue(model, 'model'); await setValue(key, 'secret-value')
    const submit = async () => { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
    await submit()
    expect(key.value).toBe(''); expect(host.textContent).not.toContain('secret must not be shown')
    expect(client.updateAIProvider).not.toHaveBeenCalled()
    await setValue(key, 'another-secret'); await submit()
    expect(client.createAIProvider).toHaveBeenCalledTimes(1)
    expect(client.setAIProviderSecret).toHaveBeenLastCalledWith('new-provider', { api_key: 'another-secret' })
    expect(client.updateAIProvider).toHaveBeenCalledWith('new-provider', expect.objectContaining({ enabled: true }))
    expect(key.value).toBe('')
    act(() => root.unmount())
  })
})
