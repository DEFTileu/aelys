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

it('saves a separate transcription provider and clears its key', async () => {
  client.aiProviders.mockResolvedValue([]); client.createAIProvider.mockResolvedValue({ id: 'audio-provider' }); client.setAIProviderSecret.mockResolvedValue(undefined); client.updateAIProvider.mockResolvedValue(undefined)
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await act(async () => root.render(<ProviderSettings />))
  await act(async () => host.querySelector<HTMLButtonElement>('[role=combobox]')!.click())
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(item => item.textContent === 'Transcription (OpenAI compatible)')
  expect(option).toBeTruthy(); await act(async () => option!.click())
  const set = async (label: string, value: string) => {
    const field = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith(label))!.querySelector('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  await set('Model ID', 'audio-model'); await set('API key', 'audio-secret-only')
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(client.createAIProvider).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transcription', model_policy: expect.objectContaining({ default_model: 'audio-model' }) }), { queueOnOffline: false })
  expect(client.updateAIProvider).toHaveBeenCalledWith('audio-provider', expect.objectContaining({ model_policy: expect.objectContaining({ models: [] }) }))
  expect(host.textContent).toContain('Transcription saved'); expect(host.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('')
  act(() => root.unmount())
})


it('preserves existing routing capabilities while enabling photos and tools', async () => {
  client.aiProviders.mockResolvedValue([{ id: 'existing', kind: 'claude', enabled: true, has_secret: true, model_policy: { default_model: 'model', models: [{ name: 'model', capabilities: ['streaming', 'reasoning'], context_tokens: 32000 }, { name: 'other', capabilities: ['streaming'], context_tokens: 8000 }] } }]); client.updateAIProvider.mockResolvedValue(undefined)
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host)
  await act(async () => root.render(<ProviderSettings />))
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Edit')!.click())
  for (const label of ['Tool calling', 'Images', 'PDF documents']) {
    const field = Array.from(host.querySelectorAll('label')).find(item => item.textContent === label)!.querySelector<HTMLInputElement>('input')!
    await act(async () => field.click())
  }
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(client.updateAIProvider).toHaveBeenCalledWith('existing', expect.objectContaining({ model_policy: expect.objectContaining({ models: expect.arrayContaining([expect.objectContaining({ name: 'model', capabilities: ['reasoning', 'streaming', 'tool_calling', 'images', 'documents'], context_tokens: 32000 }), expect.objectContaining({ name: 'other' })]) }) }))
  act(() => root.unmount())
})
})
