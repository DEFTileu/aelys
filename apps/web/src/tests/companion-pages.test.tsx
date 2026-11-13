import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { DevicesPanel } from '../views/settings/devices/DevicesPanel'
import type { CompanionState } from '../lib/companion/types'

const m = vi.hoisted(() => ({ native: false, list: vi.fn(), state: vi.fn(), find: vi.fn(), setLost: vi.fn(), reauth: vi.fn() }))
vi.mock('../lib/companion/serial', async (original) => ({ ...(await original<typeof import('../lib/companion/serial')>()), CompanionSerial: { supported: () => false, request: vi.fn() } }))
vi.mock('../lib/companion/api', () => ({ companion: { list: m.list, state: m.state, find: m.find, setLost: m.setLost }, reauth: m.reauth, newPairingSecret: vi.fn(), sha256Hex: vi.fn() }))
vi.mock('../lib/api', () => ({ getApiConfig: () => ({ baseUrl: 'https://aelys.example/api/v1' }) }))
vi.mock('../lib/nativeTransport', () => ({ isNativeHost: () => m.native }))

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = { name: 'Tileuzhan', email: 'owner@example.com' }
const at = (h: number, min: number) => new Date(2026, 10, 13, h, min).toISOString()
const baseState = (over: Partial<CompanionState> = {}): CompanionState => ({
  device_id: ID, display_name: 'Aelys', online: true, last_seen_at: at(14, 5), fw_version: '1.0.0', public_key: 'PUB',
  lost_mode: null, ice: { contacts: [{ name: 'A', phone: '1' }, { name: 'B', phone: '2' }], med_note: '', show_name: true },
  last_metrics: null, last_wifi_scan: null, contacts: { phone: '+7 700 000 00 00', telegram: '@owner_handle' },
  wifi: { saved: ['Home', 'Office', 'Cafe'], current: 'Office' }, battery: { pct: 64, charging: false }, settings: { brightness: 50 }, command_log: [], ...over,
})
const LOST_ON = { on: true, message: 'Please call me', show_phone: true, show_telegram: true, show_email: false, email: null, qr: 'telegram' as const, since: at(14, 10) }

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
const click = (el: Element) => act(async () => (el as HTMLElement).click())
async function mount(search = '?section=devices') {
  window.history.replaceState({}, '', `/settings${search}`)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<div className="st"><DevicesPanel owner={OWNER} /></div>)); await flush()
}
const type = (el: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  m.native = false
  m.list.mockReset().mockResolvedValue([{ device_id: ID, display_name: 'Aelys', online: true, last_seen_at: at(14, 5), wifi_current: 'Home', battery_pct: 64 }])
  m.state.mockReset().mockResolvedValue(baseState())
  m.find.mockReset().mockResolvedValue({ command_id: 'c1' })
  m.setLost.mockReset().mockResolvedValue(undefined)
  m.reauth.mockReset().mockResolvedValue({ challenge_id: 'ch1', signature: 'sig' })
})
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Devices list', () => {
  it('list shows status line from state', async () => {
    await mount()
    expect(host.textContent).toContain('Aelys')
    expect(host.textContent).toContain('Online · Home · 64%')
  })
  it('drops the parts the device did not report', async () => {
    m.list.mockResolvedValue([{ device_id: ID, display_name: 'Aelys', online: false, last_seen_at: null, wifi_current: null, battery_pct: 12 }])
    await mount()
    expect(host.textContent).toContain('Offline · 12%')
  })
  it('opens the overview in the URL when a row is clicked', async () => {
    await mount(); await click(button('Online · Home'))
    expect(window.location.search).toBe(`?section=devices&device=${ID}&page=overview`)
    expect(host.textContent).toContain('Quick actions')
  })
  it('keeps the pairing flow reachable when no device is paired', async () => {
    m.list.mockResolvedValue([]); await mount()
    expect(host.textContent).toContain('To add a companion, connect it by USB')
  })
  it('shows the list error and still offers pairing', async () => {
    m.list.mockRejectedValue(new Error('offline')); await mount()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(host.textContent).toContain('To add a companion, connect it by USB')
  })
})

describe('Aelys overview', () => {
  it('shows the device facts and quick actions', async () => {
    await mount(`?section=devices&device=${ID}&page=overview`)
    const text = host.textContent!
    for (const part of ['Online · seen now', 'Waveshare AMOLED 1.75″', '64%', 'Battery', 'Office', 'Wi-Fi', '1.0.0', 'Firmware', 'Quick actions', 'Play sound', '2 contacts', '3 saved · Office connected', 'Device settings']) expect(text).toContain(part)
    expect(button('Lost mode').textContent).toContain('Off')
  })
  it('shows when an offline Aelys was last seen', async () => {
    m.state.mockResolvedValue(baseState({ online: false }))
    await mount(`?section=devices&device=${ID}&page=overview`)
    expect(host.textContent).toContain('Last seen 14:05')
  })
  it('renders defensively against a server without the new fields', async () => {
    m.state.mockResolvedValue({ ...baseState(), contacts: undefined, wifi: undefined, battery: undefined, settings: undefined, command_log: undefined, ice: null } as unknown as CompanionState)
    await mount(`?section=devices&device=${ID}&page=overview`)
    expect(host.textContent).toContain('Quick actions'); expect(host.textContent).toContain('0 contacts')
  })
  it('find offline shows "Aelys is offline"', async () => {
    m.find.mockRejectedValue(new ApiError(409, 'DEVICE_OFFLINE', 'offline'))
    await mount(`?section=devices&device=${ID}&page=overview`)
    await click(button('Find'))
    expect(m.find).toHaveBeenCalledWith(ID)
    expect(host.textContent).toContain('Aelys is offline')
  })
  it('shows the load error instead of crashing when the state cannot be read', async () => {
    m.state.mockRejectedValue(new Error('cache miss'))
    await mount(`?section=devices&device=${ID}&page=overview`)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
  it('polls the state every 5 s while the page is visible and stops on unmount', async () => {
    vi.useFakeTimers()
    await mount(`?section=devices&device=${ID}&page=overview`)
    expect(m.state).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); expect(m.state).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); expect(m.state).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    act(() => root.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) }); expect(m.state).toHaveBeenCalledTimes(2)
  })
})

describe('Lost mode', () => {
  const lostUrl = `?section=devices&device=${ID}&page=lost`
  it('turn on sends message and toggles', async () => {
    m.state.mockResolvedValueOnce(baseState()).mockResolvedValue(baseState({ lost_mode: { ...LOST_ON, message: 'Call me' } }))
    await mount(lostUrl)
    expect(host.textContent).toContain('This Aelys is lost') // the live preview
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Message"]')!, 'Call me')
    expect(host.querySelector('[data-testid="round-preview"]')!.textContent).toContain('Call me')
    await click(host.querySelector('input[aria-label="Telegram"]')!)
    await click(host.querySelector('input[aria-label="Email"]')!)
    await click(button('Turn on lost mode'))
    expect(m.setLost).toHaveBeenCalledWith(ID, { on: true, message: 'Call me', show_phone: true, show_telegram: false, show_email: true, email: 'owner@example.com', qr: 'telegram' })
    expect(host.textContent).toContain('Lost mode is on')
    expect(host.textContent).toContain('since 14:10')
  })
  it('message input stops at 60 characters', async () => {
    await mount(lostUrl)
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Message"]')!
    expect(input.maxLength).toBe(60)
    await type(input, 'x'.repeat(75))
    expect(input.value).toHaveLength(60)
  })
  it('shows when and where Aelys was last seen while lost mode is on', async () => {
    m.state.mockResolvedValue(baseState({ lost_mode: LOST_ON }))
    await mount(lostUrl)
    for (const part of ['Last seen 14:05', 'On Wi-Fi “Office”', 'Aelys has no GPS. Aelys shows the last Wi-Fi network it used.']) expect(host.textContent).toContain(part)
    expect(host.textContent).not.toContain('Requires your fingerprint') // a plain browser asks for no fingerprint
    await click(button('Play sound')); expect(m.find).toHaveBeenCalledWith(ID)
  })
  it('shows the fingerprint subtitle on a native host', async () => {
    m.state.mockResolvedValue(baseState({ lost_mode: LOST_ON })); m.native = true
    await mount(lostUrl); expect(host.textContent).toContain('Requires your fingerprint')
  })
  it('turn off asks for reauth and sends it', async () => {
    m.state.mockResolvedValueOnce(baseState({ lost_mode: LOST_ON })).mockResolvedValue(baseState())
    let release: (v: { challenge_id: string; signature: string }) => void = () => {}
    m.reauth.mockReturnValue(new Promise((resolve) => { release = resolve }))
    await mount(lostUrl)
    await click(button('Turn off lost mode'))
    expect(host.textContent).toContain("Confirm it's you")
    expect(host.textContent).toContain('Turning off lost mode shows your tasks and notifications on Aelys again')
    expect(host.textContent).not.toContain('Use PIN instead')
    expect(m.reauth).toHaveBeenCalledWith('lost_off', ID)
    await act(async () => release({ challenge_id: 'ch1', signature: 'sig' }))
    expect(m.setLost).toHaveBeenCalledWith(ID, expect.objectContaining({ on: false, message: 'Please call me', reauth: { challenge_id: 'ch1', signature: 'sig' } }))
    expect(host.textContent).not.toContain("Confirm it's you")
    expect(host.textContent).toContain('Turn on lost mode')
  })
  it('reauth cancel sends nothing', async () => {
    m.state.mockResolvedValue(baseState({ lost_mode: LOST_ON }))
    let release: (v: { challenge_id: string; signature: string }) => void = () => {}
    m.reauth.mockReturnValue(new Promise((resolve) => { release = resolve }))
    await mount(lostUrl)
    await click(button('Turn off lost mode')); await click(button('Cancel'))
    expect(host.textContent).not.toContain("Confirm it's you")
    await act(async () => release({ challenge_id: 'late', signature: 'late' }))
    expect(m.setLost).not.toHaveBeenCalled()
  })
  it('shows an error and sends nothing when the fingerprint check fails', async () => {
    m.state.mockResolvedValue(baseState({ lost_mode: LOST_ON })); m.reauth.mockRejectedValue(new Error('denied'))
    await mount(lostUrl); await click(button('Turn off lost mode'))
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(m.setLost).not.toHaveBeenCalled()
  })
})
