import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeTransport, isNativeHost, nativeBackendOrigin, type NativeInvoke } from '../lib/nativeTransport'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ })

describe('native transport', () => {
  it('forwards the exact Keychain authorization scopes to native IPC', async () => {
    const invoke = vi.fn(async () => true)
    const transport = createNativeTransport(invoke as NativeInvoke)
    expect(await transport.authorizeKeychain('https://aelys.example', 'session')).toBe(true)
    expect(await transport.authorizeKeychain('https://aelys.example', 'touch_id_policy')).toBe(true)
    expect(invoke.mock.calls).toEqual([
      ['native_keychain_authorize', { origin: 'https://aelys.example', scope: 'session' }],
      ['native_keychain_authorize', { origin: 'https://aelys.example', scope: 'touch_id_policy' }],
    ])
  })
  it('keeps the backend origin explicit', () => {
    expect(nativeBackendOrigin('/api/v1')).toBe('http://127.0.0.1:8000')
    expect(nativeBackendOrigin('https://aelys.example/api/v1')).toBe('https://aelys.example')
    expect(nativeBackendOrigin('ftp://untrusted.example/api/v1')).toBe('ftp://untrusted.example')
  })
  it('detects the native host without invoking internal APIs', () => {
    expect(isNativeHost()).toBe(false)
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    expect(isNativeHost()).toBe(true)
  })

  it('forwards typed auth and health commands to the injected IPC only', async () => {
    const status = { signed_in: true, owner_id: 'owner', device_id: 'device', can_resume: true, initialized: true }
    const invoke = vi.fn(async (command: string) => command === 'native_health' ? true : status)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const localSpy = vi.spyOn(Storage.prototype, 'setItem')
    const transport = createNativeTransport(invoke as NativeInvoke)
    const origin = 'https://aelys.example'
    expect(await transport.status(origin)).toEqual(status)
    expect(await transport.health(origin)).toBe(true)
    expect(await transport.login(origin, 'owner@example.test', 'password', false)).toEqual(status)
    await transport.login(origin, 'owner@example.test', 'password', true)
    expect(await transport.resume(origin)).toEqual(status)
    expect(await transport.logout(origin)).toEqual(status)
    expect(invoke.mock.calls).toEqual([
      ['native_status', { origin }],
      ['native_health', { origin }],
      ['native_login', { origin, email: 'owner@example.test', password: 'password', bootstrap: false }],
      ['native_login', { origin, email: 'owner@example.test', password: 'password', bootstrap: true }],
      ['native_resume', { origin }],
      ['native_logout', { origin }],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(localSpy).not.toHaveBeenCalled()
  })

  it('propagates IPC errors without falling back to browser requests', async () => {
    const error = new Error('native unavailable')
    const invoke: NativeInvoke = async () => { throw error }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(createNativeTransport(invoke).resume('https://aelys.example')).rejects.toBe(error)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards biometric status and changes to native commands', async () => {
    const status = { supported: true, available: true, enabled: false }
    const invoke = vi.fn(async () => status)
    const transport = createNativeTransport(invoke as NativeInvoke)
    expect(await transport.biometricStatus('https://aelys.example')).toEqual(status)
    await transport.setBiometric('https://aelys.example', true)
    expect(invoke.mock.calls).toEqual([
      ['native_biometric_status', { origin: 'https://aelys.example' }],
      ['native_biometric_set', { origin: 'https://aelys.example', enabled: true }],
    ])
  })
})
