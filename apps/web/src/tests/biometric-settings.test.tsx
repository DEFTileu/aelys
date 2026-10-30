import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BiometricSettings } from '../components/BiometricSettings'

const native = vi.hoisted(() => ({ biometricStatus: vi.fn(), setBiometric: vi.fn(), authorizeKeychain: vi.fn() }))
vi.mock('../lib/nativeTransport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/nativeTransport')>(),
  loadNativeTransport: async () => native,
}))
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => { native.biometricStatus.mockReset(); native.setBiometric.mockReset(); native.authorizeKeychain.mockReset() })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })
async function mount() {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(<BiometricSettings />) })
  return host
}

describe('biometric settings', () => {
  it('authorizes only on request and reloads status without changing Touch ID', async () => {
    native.biometricStatus.mockRejectedValueOnce('KEYCHAIN_ACCESS_REQUIRED').mockResolvedValueOnce({ supported: true, available: true, enabled: false })
    native.authorizeKeychain.mockResolvedValue(true)
    const host = await mount()
    expect(native.authorizeKeychain).not.toHaveBeenCalled()
    await act(async () => { [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Разрешить доступ macOS'))!.click() })
    expect(native.authorizeKeychain).toHaveBeenCalledWith('http://127.0.0.1:8000', 'touch_id_policy')
    expect(native.biometricStatus).toHaveBeenCalledTimes(2)
    expect(native.setBiometric).not.toHaveBeenCalled()
    expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
  })
  it('allows retry after cancelled authorization without changing the switch', async () => {
    native.biometricStatus.mockResolvedValue({ supported: true, available: true, enabled: false })
    native.setBiometric.mockRejectedValue('KEYCHAIN_ACCESS_REQUIRED')
    let reject!: (reason: unknown) => void
    native.authorizeKeychain.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail })).mockResolvedValueOnce(false)
    const host = await mount()
    const toggle = host.querySelector('[role=switch]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    const recovery = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Разрешить доступ macOS'))!
    await act(async () => { recovery.click() })
    expect(recovery.disabled).toBe(true)
    expect(toggle.disabled).toBe(true)
    await act(async () => { reject(new Error('private detail')) })
    expect(recovery.disabled).toBe(false)
    expect(host.textContent).not.toContain('private detail')
    await act(async () => { recovery.click() })
    expect(native.biometricStatus).toHaveBeenCalledTimes(2)
    expect(native.setBiometric).toHaveBeenCalledTimes(1)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
  it('shows the Keychain notice if checking settings is denied', async () => {
    native.biometricStatus.mockRejectedValue('KEYCHAIN_ACCESS_REQUIRED')
    const host = await mount()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Нужен доступ к связке ключей')
  })
  it('keeps the authoritative off state when Keychain access is denied', async () => {
    native.biometricStatus.mockResolvedValue({ supported: true, available: true, enabled: false })
    native.setBiometric.mockRejectedValue(new Error('KEYCHAIN_ACCESS_REQUIRED'))
    const host = await mount()
    const toggle = host.querySelector('[role=switch]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(false)
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Нужен доступ к связке ключей')
  })
  it('hides the switch when the native platform does not support it', async () => {
    native.biometricStatus.mockResolvedValue({ supported: false, available: false, enabled: false })
    const host = await mount()
    expect(host.querySelector('[role=switch]')).toBeNull()
    expect(native.setBiometric).not.toHaveBeenCalled()
  })
  it('explains unavailable Touch ID and disables changes', async () => {
    native.biometricStatus.mockResolvedValue({ supported: true, available: false, enabled: false })
    const host = await mount()
    expect(host.textContent).toContain('Touch ID недоступен')
    expect((host.querySelector('[role=switch]') as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps the authoritative value during a prompt and after cancellation', async () => {
    native.biometricStatus.mockResolvedValue({ supported: true, available: true, enabled: false })
    let reject!: (reason: Error) => void
    native.setBiometric.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    const host = await mount(); const toggle = host.querySelector('[role=switch]') as HTMLButtonElement
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
    expect(native.setBiometric).toHaveBeenCalledWith('http://127.0.0.1:8000', true)
    await act(async () => { reject(new Error('secret details')) })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(false)
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Не удалось изменить')
    expect(host.textContent).not.toContain('secret details')
  })
  it('uses the native response after a successful prompt', async () => {
    native.biometricStatus.mockResolvedValue({ supported: true, available: true, enabled: false })
    native.setBiometric.mockResolvedValue({ supported: true, available: true, enabled: true })
    const host = await mount()
    await act(async () => { (host.querySelector('[role=switch]') as HTMLButtonElement).click() })
    expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('true')
  })
  it('permits the signed-in owner to disable after biometric enrollment becomes unavailable', async () => {
    native.biometricStatus.mockResolvedValue({ supported: true, available: false, enabled: true })
    native.setBiometric.mockResolvedValue({ supported: true, available: false, enabled: false })
    const host = await mount()
    const toggle = host.querySelector('[role=switch]') as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    await act(async () => { toggle.click() })
    expect(native.setBiometric).toHaveBeenCalledWith('http://127.0.0.1:8000', false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})
