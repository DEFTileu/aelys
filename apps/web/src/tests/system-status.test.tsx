import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatusPanel } from '../views/settings/StatusPanel'

const api = vi.hoisted(() => ({
  getSystemStatus: vi.fn(), getSystemEvents: vi.fn(), syncStatus: vi.fn(), devices: vi.fn(),
}))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => api }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function mount(apiStatus: 'ready' | 'offline' = 'ready') {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<StatusPanel apiStatus={apiStatus} />))
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const status = { checked_at: '2026-11-18T10:00:00Z', api: 'ok' as const, database: 'ok' as const, uptime_seconds: 3661 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  api.getSystemStatus.mockResolvedValue(status)
  api.getSystemEvents.mockResolvedValue({ items: [{ id: 'e1', action: 'task.update', decision: 'allow', outcome: 'success', created_at: '2026-11-18T09:59:00Z' }] })
  api.syncStatus.mockResolvedValue({ latest_cursor: 'c2', acknowledged_cursor: 'c2', acknowledged_seq: 2, compaction_watermark: 0 })
  api.devices.mockResolvedValue([{ id: 'd1', platform: 'web', display_name: 'Web', revoked_at: null }])
})
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ''; vi.useRealTimers() })

describe('system status panel', () => {
  it('shows live server, database, uptime, sync, device count, and audit events', async () => {
    await mount(); await flush()
    expect(host.textContent).toContain('Сервер / API')
    expect(host.textContent).toContain('База данных')
    expect(host.textContent).toContain('1 ч 1 мин')
    expect(host.textContent).toContain('Серверные изменения подтверждены')
    expect(host.textContent).toContain('1')
    expect(host.textContent).toContain('task.update')
    expect(host.textContent).toContain('События безопасности и доступа')
    expect(api.getSystemStatus).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true, allowCacheFallback: false }))
    expect(api.getSystemEvents).toHaveBeenCalledWith(50, expect.objectContaining({ forceRefresh: true, allowCacheFallback: false }))
  })

  it('does not leave a previous live green state after a failed refresh', async () => {
    await mount(); await flush()
    api.getSystemStatus.mockRejectedValueOnce(new Error('offline'))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Обновить статус"]')!.click())
    await flush()
    expect(host.textContent).toContain('Не удалось получить живой статус')
    expect(host.textContent).not.toContain('База данных: работает')
  })

  it('manual refresh dispatches the shared API check event and filters audit rows', async () => {
    await mount(); await flush()
    const check = vi.fn(); window.addEventListener('aelys:check-api', check)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Обновить статус"]')!.click())
    await flush()
    expect(check).toHaveBeenCalledOnce()
    const filter = host.querySelector<HTMLInputElement>('[aria-label="Фильтр событий"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'finance'); filter.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(host.textContent).toContain('События не найдены')
    expect(host.textContent).not.toContain('task.update')
    window.removeEventListener('aelys:check-api', check)
  })

  it('keeps unsupported sync and device summaries distinct from live server health', async () => {
    api.syncStatus.mockRejectedValue(Object.assign(new Error('unsupported'), { status: 404 }))
    api.devices.mockRejectedValue(new Error('unavailable'))
    await mount('offline'); await flush()
    expect(host.textContent).toContain('Последняя фоновая проверка API')
    expect(host.textContent).toContain('Нет соединения')
    expect(host.textContent).not.toContain('Сервер / API')
    expect(host.textContent).not.toContain('База данных')
    expect(host.textContent).toContain('Синхронизация не поддерживается')
    expect(host.textContent).toContain('Не удалось загрузить устройства')
  })

  it('polls only while visible and ignores a response after unmount', async () => {
    vi.useFakeTimers()
    let finish!: (value: typeof status) => void
    api.getSystemStatus.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await mount()
    act(() => root.unmount())
    await act(async () => { finish(status); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.getSystemStatus).toHaveBeenCalledTimes(1)
  })
})
