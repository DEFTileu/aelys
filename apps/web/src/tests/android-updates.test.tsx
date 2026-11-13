import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ host: true, invoke: vi.fn(), progress: null as null | ((value: { downloaded: number; total: number }) => void) }))
vi.mock('../lib/nativeTransport', () => ({ isNativeHost: () => native.host }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class { constructor(callback: (value: { downloaded: number; total: number }) => void) { native.progress = callback } },
}))

let host: HTMLDivElement
let root: Root
let Notice: typeof import('../components/AndroidUpdateNotice').AndroidUpdateNotice
let Panel: typeof import('../views/settings/AndroidUpdatesPanel').AndroidUpdatesPanel
const available = { supported: true, current_version: '1.0.0', update: { version: '1.1.0', size_bytes: 100 } }
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll('button')].find(item => item.textContent === label)!
async function click(label: string, scope?: ParentNode) { const item = button(label, scope); expect(item).toBeTruthy(); await act(async () => item.click()) }
async function mount() { await act(async () => root.render(<><Notice /><Panel /></>)) }

beforeEach(async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.resetModules(); vi.clearAllMocks(); native.host = true; native.progress = null
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android' })
  native.invoke.mockImplementation(async (command: string) => command === 'android_update_check' ? available : command === 'android_update_install' ? 'installer_opened' : undefined)
  ;({ AndroidUpdateNotice: Notice } = await import('../components/AndroidUpdateNotice'))
  ;({ AndroidUpdatesPanel: Panel } = await import('../views/settings/AndroidUpdatesPanel'))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Android updates', () => {
  it.each([[false, 'Android'], [true, 'Macintosh']])('does not invoke native commands outside Android (host=%s, ua=%s)', async (isHost, ua) => {
    native.host = isHost; Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua })
    await mount(); expect(native.invoke).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Check for updates')
  })
  it('hides update controls when the native host reports unsupported', async () => {
    native.invoke.mockResolvedValue({ supported: false, current_version: '1.0.0', update: null })
    await mount(); expect(native.invoke).toHaveBeenCalledTimes(1); expect(host.textContent).not.toContain('Check for updates')
  })
  it('checks once on startup without downloading and dismissal leaves About available', async () => {
    await mount()
    expect(native.invoke).toHaveBeenCalledTimes(1); expect(native.invoke).toHaveBeenCalledWith('android_update_check')
    expect(host.querySelector('aside')?.textContent).toContain('1.1.0')
    expect(host.textContent).toContain('1.0.0')
    await click('Dismiss', host.querySelector('aside')!)
    expect(host.querySelector('aside')).toBeNull(); expect(host.textContent).toContain('1.1.0'); expect(button('Update')).toBeTruthy()
  })
  it('downloads once on explicit click, shows progress and opens the installer', async () => {
    let finish!: () => void
    native.invoke.mockImplementation((command: string) => command === 'android_update_check' ? Promise.resolve(available) : command === 'android_update_download' ? new Promise<void>(resolve => { finish = resolve }) : Promise.resolve('installer_opened'))
    await mount(); await click('Update', host.querySelector('aside')!)
    expect(native.invoke.mock.calls.filter(call => call[0] === 'android_update_download')).toHaveLength(1)
    const downloading = [...host.querySelectorAll('button')].filter(item => item.textContent?.includes('Downloading'))
    expect(downloading).toHaveLength(2); expect(downloading.every(item => item.disabled)).toBe(true)
    await act(async () => downloading[1].click())
    expect(native.invoke.mock.calls.filter(call => call[0] === 'android_update_download')).toHaveLength(1)
    await act(async () => native.progress!({ downloaded: 50, total: 100 }))
    expect(host.textContent).toContain('50%')
    await act(async () => finish())
    expect(native.invoke).toHaveBeenCalledWith('android_update_install')
    expect(host.textContent).toContain('installer opened')
  })
  it('retries permission without downloading again', async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'android_update_check') return available
      if (command === 'android_update_install' && native.invoke.mock.calls.filter(call => call[0] === command).length === 1) throw 'UPDATE_PERMISSION_REQUIRED'
      return command === 'android_update_install' ? 'installer_opened' : undefined
    })
    await mount(); await click('Update', host.querySelector('aside')!)
    expect(host.textContent).toContain('permission')
    await click('Retry', host.querySelector('aside')!)
    expect(native.invoke.mock.calls.filter(call => call[0] === 'android_update_download')).toHaveLength(1)
    expect(native.invoke.mock.calls.filter(call => call[0] === 'android_update_install')).toHaveLength(2)
  })
  it('keeps startup failures silent and shows safe manual check errors with retry', async () => {
    native.invoke.mockRejectedValue(new Error('secret /private/path'))
    await mount(); expect(host.textContent).not.toContain('secret'); expect(host.textContent).not.toContain('Could not check')
    await click('Check for updates'); expect(host.textContent).toContain('Could not check for updates'); expect(host.textContent).not.toContain('/private/path')
    native.invoke.mockResolvedValue(available); await click('Check for updates'); expect(host.textContent).toContain('1.1.0')
  })
  it('shows a safe download error and retries the download', async () => {
    native.invoke.mockImplementation(async (command: string) => { if (command === 'android_update_check') return available; if (command === 'android_update_download') throw 'secret /private/path'; return 'installer_opened' })
    await mount(); await click('Update', host.querySelector('aside')!)
    expect(host.textContent).toContain('Could not update'); expect(host.textContent).not.toContain('secret')
    native.invoke.mockImplementation(async (command: string) => command === 'android_update_install' ? 'installer_opened' : undefined)
    await click('Retry', host.querySelector('aside')!); expect(host.textContent).toContain('installer opened')
    expect(native.invoke.mock.calls.filter(call => call[0] === 'android_update_download')).toHaveLength(2)
  })
  it('clears an old offer when rechecking fails because native pending state was invalidated', async () => {
    await mount()
    native.invoke.mockRejectedValue('UPDATE_CHANNEL_UNAVAILABLE')
    await click('Check for updates')
    expect(host.querySelector('aside')).toBeNull()
    expect(button('Update')).toBeUndefined()
    expect(host.textContent).toContain('Update channel is not available')
  })
  it('confirms a successful check with no newer release', async () => {
    native.invoke.mockResolvedValue({ supported: true, current_version: '1.0.0', update: null })
    await mount()
    expect(host.textContent).toContain('Aelys is up to date')
  })
  it('downloads again when the cached artifact fails verification at installation', async () => {
    let installs = 0
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'android_update_check') return available
      if (command === 'android_update_install' && installs++ === 0) throw 'UPDATE_INTEGRITY_FAILED'
      return 'installer_opened'
    })
    await mount(); await click('Update', host.querySelector('aside')!)
    await click('Retry', host.querySelector('aside')!)
    expect(native.invoke.mock.calls.filter(call => call[0] === 'android_update_download')).toHaveLength(2)
  })
})
