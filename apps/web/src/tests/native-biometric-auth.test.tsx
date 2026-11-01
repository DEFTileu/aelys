import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from '../components/AuthGate'
import { isKeychainAccessRequired } from '../lib/nativeTransport'

const native = vi.hoisted(() => ({ status: vi.fn(), resume: vi.fn(), login: vi.fn(), authorizeKeychain: vi.fn() }))
vi.mock('../lib/nativeTransport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/nativeTransport')>(),
  isNativeHost: () => true,
  loadNativeTransport: async () => native,
}))
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => {
  localStorage.removeItem('aelys.signedOut')
  native.status.mockReset().mockResolvedValue({ signed_in: false, initialized: true, can_resume: true, biometric_locked: true })
  native.resume.mockReset(); native.login.mockReset(); native.authorizeKeychain.mockReset()
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })
async function mount(apiStatus: 'ready' | 'error' = 'ready') {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(<AuthGate apiStatus={apiStatus}><div>Protected data</div></AuthGate>) })
  return host
}
function button(host: HTMLElement, label: string) { return [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))! }

describe('native biometric entry', () => {
  it('shows the visual introduction without unlocking the session', async () => {
    const host = await mount()
    // The introduction and the entry card are one scene; its decorative layers stay hidden from assistive tech.
    expect(host.querySelector('.launch-intro__backdrop')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('.launch-stage__hero')?.getAttribute('aria-hidden')).toBe('true')
    expect(button(host, 'Unlock with Touch ID')).toBeDefined()
    expect(native.resume).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Protected data')
  })
  it('shows password entry on Android even if a session is reported as biometric locked', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android')
    const host = await mount()
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(host.textContent).not.toContain('Touch ID')
    expect(native.resume).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Protected data')
  })
  it('keeps explicit sign-out closed even if native status has a resumable credential', async () => {
    localStorage.setItem('aelys.signedOut', '1')
    const host = await mount()
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(native.resume).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Protected data')
  })
  it('returns to explicit unlock on access expiry without automatic resume', async () => {
    native.status.mockResolvedValueOnce({ signed_in: true }).mockResolvedValue({ signed_in: false, initialized: true, can_resume: true, biometric_locked: true })
    const host = await mount()
    expect(host.textContent).toContain('Protected data')
    await act(async () => { window.dispatchEvent(new CustomEvent('aelys:native-session-expired', { detail: { origin: 'http://127.0.0.1:8000' } })) })
    expect(host.textContent).not.toContain('Protected data')
    expect(button(host, 'Unlock with Touch ID')).toBeDefined()
    expect(native.resume).not.toHaveBeenCalled()
  })
  it('requires a click and returns to explicit unlock after Keychain authorization', async () => {
    native.status.mockRejectedValueOnce('KEYCHAIN_ACCESS_REQUIRED').mockResolvedValueOnce({ signed_in: false, initialized: true, can_resume: true, biometric_locked: true })
    native.authorizeKeychain.mockResolvedValue(true)
    const host = await mount()
    expect(native.authorizeKeychain).not.toHaveBeenCalled()
    await act(async () => { button(host, 'Allow macOS access').click() })
    expect(native.authorizeKeychain).toHaveBeenCalledWith('http://127.0.0.1:8000', 'session')
    expect(native.status).toHaveBeenCalledTimes(2)
    expect(native.resume).not.toHaveBeenCalled()
    expect(button(host, 'Unlock with Touch ID')).toBeDefined()
    expect(host.textContent).not.toContain('Protected data')
  })
  it('retains the entry and permits retry after authorization cancellation', async () => {
    native.resume.mockRejectedValue('KEYCHAIN_ACCESS_REQUIRED')
    const host = await mount()
    await act(async () => { button(host, 'Unlock with Touch ID').click() })
    let reject!: (reason: unknown) => void
    native.authorizeKeychain.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail })).mockResolvedValueOnce(false)
    const unlockButton = button(host, 'Unlock with Touch ID')
    const recoveryButton = button(host, 'Allow macOS access')
    await act(async () => { recoveryButton.click() })
    expect(recoveryButton.disabled).toBe(true)
    expect(unlockButton.disabled).toBe(true)
    expect(button(host, 'Sign in with password').disabled).toBe(true)
    await act(async () => { reject('cancelled private detail') })
    expect(button(host, 'Allow macOS access').disabled).toBe(false)
    expect(host.textContent).not.toContain('cancelled private detail')
    await act(async () => { button(host, 'Allow macOS access').click() })
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(host.textContent).toContain('No saved session found')
    expect(native.resume).toHaveBeenCalledTimes(1)
  })
  it('does not label permission as Touch ID or auto resume when the biometric policy is off', async () => {
    native.status.mockRejectedValueOnce('KEYCHAIN_ACCESS_REQUIRED').mockResolvedValueOnce({ signed_in: false, initialized: true, can_resume: true, biometric_locked: false })
    native.authorizeKeychain.mockResolvedValue(true)
    const host = await mount()
    await act(async () => { button(host, 'Allow macOS access').click() })
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(host.textContent).not.toContain('Unlock with Touch ID')
    expect(native.resume).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Protected data')
  })
  it('recognizes only the exact safe native error code', () => {
    expect(isKeychainAccessRequired('KEYCHAIN_ACCESS_REQUIRED')).toBe(true)
    expect(isKeychainAccessRequired(new Error('KEYCHAIN_ACCESS_REQUIRED'))).toBe(true)
    expect(isKeychainAccessRequired('KEYCHAIN_ACCESS_REQUIRED secret')).toBe(false)
    expect(isKeychainAccessRequired({ message: 'KEYCHAIN_ACCESS_REQUIRED' })).toBe(false)
  })
  it('shows sign-in and the Keychain notice when status is denied', async () => {
    native.status.mockRejectedValue('KEYCHAIN_ACCESS_REQUIRED')
    const host = await mount()
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Keychain access is required')
    expect(host.textContent).not.toContain('Server unavailable')
    expect(native.resume).not.toHaveBeenCalled()
  })
  it('shows the Keychain notice when automatic resume is denied', async () => {
    native.status.mockResolvedValue({ signed_in: false, initialized: true, can_resume: true, biometric_locked: false })
    native.resume.mockRejectedValue(new Error('KEYCHAIN_ACCESS_REQUIRED'))
    const host = await mount()
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Keychain access is required')
    expect(host.textContent).not.toContain('Server unavailable')
  })
  it('retains both unlock options when explicit resume is denied Keychain access', async () => {
    native.resume.mockRejectedValue('KEYCHAIN_ACCESS_REQUIRED')
    const host = await mount()
    await act(async () => { button(host, 'Unlock with Touch ID').click() })
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Keychain access is required')
    expect(button(host, 'Unlock with Touch ID').disabled).toBe(false)
    expect(button(host, 'Sign in with password').disabled).toBe(false)
    expect(host.textContent).not.toContain('Protected data')
  })
  it('shows the Keychain notice when password sign-in is denied', async () => {
    native.login.mockRejectedValue(new Error('KEYCHAIN_ACCESS_REQUIRED'))
    const host = await mount()
    await act(async () => { button(host, 'Sign in with password').click() })
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Keychain access is required')
  })
  it('waits for explicit unlock and permits retry after cancellation', async () => {
    native.resume.mockRejectedValueOnce(new Error('secret details')).mockResolvedValueOnce({ signed_in: true })
    const host = await mount()
    expect(native.resume).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Protected data')
    await act(async () => { button(host, 'Unlock with Touch ID').click() })
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Could not unlock')
    expect(host.textContent).not.toContain('secret details')
    expect(button(host, 'Unlock with Touch ID').disabled).toBe(false)
    await act(async () => { button(host, 'Unlock with Touch ID').click() })
    expect(native.resume).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Protected data')
  })
  it('offers password login without prompting Touch ID', async () => {
    const host = await mount()
    await act(async () => { button(host, 'Sign in with password').click() })
    expect(host.querySelector('input[type=password]')).not.toBeNull()
    expect(native.resume).not.toHaveBeenCalled()
    await act(async () => { button(host, 'Back to Touch ID').click() })
    expect(button(host, 'Unlock with Touch ID')).toBeDefined()
    expect(native.resume).not.toHaveBeenCalled()
  })
  it('does not show Android connection advice on a Mac', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const host = await mount('error')
    await act(async () => { button(host, 'Server address').click() })
    expect(host.textContent).not.toContain('Android')
  })
})
