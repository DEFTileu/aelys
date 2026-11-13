import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import vectors from './fixtures/companion-vectors.json'
import { DevicesPanel } from '../views/settings/devices/DevicesPanel'
import type { CompanionCommandLogEntry, CompanionState } from '../lib/companion/types'

const m = vi.hoisted(() => ({
  list: vi.fn(), state: vi.fn(), reauth: vi.fn(), setIce: vi.fn(), scanWifi: vi.fn(), addWifi: vi.fn(), removeWifi: vi.fn(),
  orderWifi: vi.fn(), setSettings: vi.fn(), restart: vi.fn(), unpair: vi.fn(),
}))
vi.mock('../lib/companion/serial', async (original) => ({ ...(await original<typeof import('../lib/companion/serial')>()), CompanionSerial: { supported: () => false, request: vi.fn() } }))
vi.mock('../lib/companion/api', async () => ({
  companion: { list: m.list, state: m.state, setIce: m.setIce, scanWifi: m.scanWifi, addWifi: m.addWifi, removeWifi: m.removeWifi, orderWifi: m.orderWifi, setSettings: m.setSettings, restart: m.restart, unpair: m.unpair },
  reauth: m.reauth,
  encryptWifi: (await import('../lib/companion/ecies')).encryptWifi,
  newPairingSecret: () => 'S1', sha256Hex: async () => 'hash',
}))
vi.mock('../lib/api', () => ({ getApiConfig: () => ({ baseUrl: 'https://aelys.example/api/v1' }) }))
vi.mock('../lib/nativeTransport', () => ({ isNativeHost: () => false }))

const ID = vectors.device_id
const OWNER = { name: 'Tileuzhan K.', email: 'owner@example.com' }
const PASSWORD = 'hunter2-s3cret'
const baseState = (over: Partial<CompanionState> = {}): CompanionState => ({
  device_id: ID, display_name: 'Aelys', online: true, last_seen_at: null, fw_version: '1.0.0', public_key: vectors.device_pub_b64,
  lost_mode: null, ice: { owner_name: 'Tileuzhan K.', contacts: [{ name: 'Aigerim', relation: 'Sister', phone: '+7 701 555 98 76' }], med_note: 'Allergy: penicillin', show_name: true, show_contacts: true, show_med: false },
  last_metrics: null, last_wifi_scan: null, contacts: null, wifi: { saved: ['Home', 'Office', 'Cafe'], current: 'Home' }, battery: null, settings: { brightness: 70 }, command_log: [], ...over,
})
const entry = (over: Partial<CompanionCommandLogEntry>): CompanionCommandLogEntry => ({ id: 'cmd1', name: 'wifi_add', sent_at: '2026-11-13T10:00:00Z', ok: null, error_code: null, ...over })

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)) }) // real crypto is async
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
const byLabel = <T extends Element>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!
const click = (el: Element) => act(async () => (el as HTMLElement).click())
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }))
})
async function mount(page: string) {
  window.history.replaceState({}, '', `/settings?section=devices&device=${ID}&page=${page}`)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<div className="st"><DevicesPanel owner={OWNER} /></div>)); await flush()
}
const allRequests = () => JSON.stringify([m.setIce, m.scanWifi, m.addWifi, m.removeWifi, m.orderWifi, m.setSettings, m.restart, m.unpair, m.state].map((f) => f.mock.calls))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const f of Object.values(m)) f.mockReset()
  m.list.mockResolvedValue([])
  m.state.mockResolvedValue(baseState())
  m.setIce.mockResolvedValue(undefined)
  m.scanWifi.mockResolvedValue({ command_id: 'scan1' })
  m.addWifi.mockResolvedValue({ command_id: 'cmd1' })
  m.removeWifi.mockResolvedValue({ command_id: 'c2' }); m.orderWifi.mockResolvedValue({ command_id: 'c3' })
  m.setSettings.mockResolvedValue({ command_id: 'c4' }); m.restart.mockResolvedValue({ command_id: 'c5' })
  m.unpair.mockResolvedValue(undefined)
  m.reauth.mockResolvedValue({ challenge_id: 'ch1', signature: 'sig' })
})
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Emergency', () => {
  it('shows the stored contacts, notes and card switches from the server', async () => {
    await mount('emergency')
    const text = host.textContent!
    for (const part of ['Opens on Aelys when both buttons are held for 2 s', 'Emergency contacts', 'Aigerim', 'Sister · +7 701 555 98 76', 'Medical notes', 'Show on Aelys card', 'Tileuzhan K.', 'Name, relation and phone', 'Shown under the contacts']) expect(text).toContain(part)
    expect(host.querySelector<HTMLTextAreaElement>('#dv-med')!.value).toBe('Allergy: penicillin')
    expect(byLabel('Your name').getAttribute('aria-checked')).toBe('true')
    expect(byLabel('Medical notes').getAttribute('aria-checked')).toBe('false')
    expect(text).not.toContain('SOS') // the SOS frames are a proposal, not built
  })
  it('ice save sends relation and show flags', async () => {
    await mount('emergency')
    await click(button('Add contact'))
    await type(byLabel('Contact 2 name'), 'Marat'); await type(byLabel('Contact 2 relation'), 'Friend'); await type(byLabel('Contact 2 phone'), '+7 702 555 43 21')
    await type(host.querySelector<HTMLTextAreaElement>('#dv-med')!, 'Blood type O+')
    await click(byLabel('Contacts')); await click(byLabel('Medical notes'))
    await click(button('Save'))
    expect(m.setIce).toHaveBeenCalledWith(ID, {
      owner_name: 'Tileuzhan K.',
      contacts: [{ name: 'Aigerim', relation: 'Sister', phone: '+7 701 555 98 76' }, { name: 'Marat', relation: 'Friend', phone: '+7 702 555 43 21' }],
      med_note: 'Blood type O+', show_name: true, show_contacts: false, show_med: true,
    })
    expect(host.textContent).toContain('Saved')
  })
  it('hides Add contact at two contacts and limits field lengths', async () => {
    await mount('emergency')
    await click(button('Add contact'))
    expect(button('Add contact')).toBeUndefined()
    expect(byLabel<HTMLInputElement>('Contact 2 name').maxLength).toBe(32)
    expect(byLabel<HTMLInputElement>('Contact 2 relation').maxLength).toBe(16)
    expect(byLabel<HTMLInputElement>('Contact 2 phone').maxLength).toBe(23)
    expect(host.querySelector<HTMLTextAreaElement>('#dv-med')!.maxLength).toBe(96)
  })
  it('removes a contact and refuses a half-filled one', async () => {
    await mount('emergency')
    await click(button('Add contact')); await type(byLabel('Contact 2 name'), 'Marat')
    await click(button('Save'))
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(m.setIce).not.toHaveBeenCalled()
    await click(button('Remove contact'))
    await click(button('Save'))
    expect(m.setIce).toHaveBeenCalledWith(ID, expect.objectContaining({ contacts: [expect.objectContaining({ name: 'Aigerim' })] }))
  })
  it('renders without stored ICE (an older server)', async () => {
    m.state.mockResolvedValue({ ...baseState(), ice: null })
    await mount('emergency')
    expect(host.textContent).toContain('Emergency contacts'); expect(button('Add contact')).toBeTruthy()
  })
  it('goes back to the overview', async () => {
    await mount('emergency'); await click(byLabel('Back'))
    expect(window.location.search).toBe(`?section=devices&device=${ID}&page=overview`)
  })
})

describe('Wi-Fi saved networks', () => {
  it('lists saved networks with Connected / Saved and the design copy', async () => {
    await mount('wifi')
    const text = host.textContent!
    for (const part of ['Networks Aelys can join · 2.4 GHz', 'Saved networks', 'Home', 'Connected', 'Office', 'Saved', 'Aelys joins the first network in range. Drag to change the order.', 'Passwords are encrypted on this phone for Aelys only. Aelys servers never see them.']) expect(text).toContain(part)
    expect(host.querySelectorAll('[data-testid="wifi-row"]')).toHaveLength(3)
  })
  it('reorder sends new order', async () => {
    await mount('wifi')
    expect(byLabel<HTMLButtonElement>('Move Home up').disabled).toBe(true)
    await click(byLabel('Move Home down'))
    expect(m.orderWifi).toHaveBeenCalledWith(ID, ['Office', 'Home', 'Cafe'])
    expect([...host.querySelectorAll('[data-testid="wifi-row"]')].map((r) => r.textContent)[0]).toContain('Office')
    await click(byLabel('Move Cafe up'))
    expect(m.orderWifi).toHaveBeenLastCalledWith(ID, ['Office', 'Cafe', 'Home'])
  })
  it('reorders by dragging the handle', async () => {
    await mount('wifi')
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="wifi-row"]')]
    rows.forEach((row, i) => { row.getBoundingClientRect = () => ({ top: i * 60, bottom: i * 60 + 60, height: 60, left: 0, right: 300, width: 300, x: 0, y: i * 60, toJSON: () => ({}) }) })
    const grip = byLabel('Reorder Home')
    const fire = (type: string, y: number) => act(async () => { grip.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientY: y }), { pointerId: 1 })) })
    await fire('pointerdown', 30); await fire('pointermove', 95); await fire('pointerup', 95)
    expect(m.orderWifi).toHaveBeenCalledWith(ID, ['Office', 'Home', 'Cafe'])
  })
  it('puts the order back and says so when the order cannot be sent', async () => {
    m.orderWifi.mockRejectedValue(new ApiError(409, 'DEVICE_OFFLINE', 'offline'))
    await mount('wifi'); await click(byLabel('Move Home down'))
    expect(host.textContent).toContain('Aelys is offline')
    expect([...host.querySelectorAll('[data-testid="wifi-row"]')].map((r) => r.textContent)[0]).toContain('Home')
  })
  it('removes a network', async () => {
    await mount('wifi'); await click(byLabel('Delete Office'))
    expect(m.removeWifi).toHaveBeenCalledWith(ID, 'Office')
    expect(host.querySelectorAll('[data-testid="wifi-row"]')).toHaveLength(2)
  })
  it('renders without a Wi-Fi block (an older server)', async () => {
    m.state.mockResolvedValue({ ...baseState(), wifi: undefined, last_wifi_scan: undefined } as unknown as CompanionState)
    await mount('wifi')
    expect(host.textContent).toContain('Saved networks'); expect(button('Add network')).toBeTruthy()
  })
})

describe('Wi-Fi add network', () => {
  const open = async () => { await mount('wifi'); await click(button('Add network')) }
  // The real WebCrypto answers on its own thread, so wait for the request instead of for fake time.
  const sendIt = async () => { const calls = m.addWifi.mock.calls.length; await click(button('Send to Aelys')); await vi.waitFor(() => expect(m.addWifi.mock.calls.length).toBe(calls + 1)); await flush() }
  const fill = async (ssid: string, password: string) => { await type(byLabel('Network name'), ssid); await type(byLabel('Password'), password) }

  it('asks Aelys to scan and lists what it sees, strongest first, and a tap fills the name', async () => {
    m.state.mockResolvedValue(baseState({ last_wifi_scan: { networks: [{ ssid: 'Guest', rssi: -80, secure: true }, { ssid: 'Cafe', rssi: -50, secure: true }, { ssid: 'Open', rssi: -55, secure: false }] } }))
    await open()
    expect(m.scanWifi).toHaveBeenCalledWith(ID)
    expect(host.textContent).toContain('Nearby · seen by Aelys')
    const names = [...host.querySelectorAll('[data-testid="nearby"]')].map((n) => n.textContent)
    expect(names[0]).toContain('Cafe'); expect(names[0]).toContain('Strong'); expect(names[2]).toContain('Weak')
    await click(host.querySelectorAll('[data-testid="nearby"]')[0]!)
    expect(byLabel<HTMLInputElement>('Network name').value).toBe('Cafe')
  })
  it('keeps manual entry when Aelys is offline for the scan', async () => {
    m.scanWifi.mockRejectedValue(new ApiError(409, 'DEVICE_OFFLINE', 'offline'))
    await open()
    expect(host.textContent).toContain('Aelys is offline'); expect(byLabel('Network name')).toBeTruthy()
  })
  it('add network encrypts and never sends the password in clear', async () => {
    await open(); await fill('Office', PASSWORD)
    await click(button('Send to Aelys')); await settle()
    expect(m.addWifi).toHaveBeenCalledTimes(1)
    const [id, blob] = m.addWifi.mock.calls[0]!
    expect(id).toBe(ID)
    expect(blob).toMatch(/^AQ[A-Za-z0-9_-]+$/) // version byte 0x01, base64url
    expect(allRequests()).not.toContain(PASSWORD); expect(allRequests()).not.toContain('hunter2')
    expect(window.location.href).not.toContain(PASSWORD)
    expect(host.querySelector('input[type="password"], input[aria-label="Password"]')).toBeNull() // the field is gone with the sheet
    expect(document.body.innerHTML).not.toContain(PASSWORD)
  })
  it('clears the password field after sending, also when the send fails', async () => {
    m.addWifi.mockRejectedValue(new ApiError(409, 'DEVICE_OFFLINE', 'offline'))
    await open(); await fill('Office', PASSWORD)
    const field = byLabel<HTMLInputElement>('Password')
    await click(button('Send to Aelys')); await settle()
    expect(field.value).toBe('')
    expect(host.textContent).toContain('Aelys is offline')
    expect(allRequests()).not.toContain(PASSWORD)
  })
  it('sends a real ECIES blob (W2 proves the crypto against the Python vector)', async () => {
    await open(); await fill('Office', 'pw')
    await click(button('Send to Aelys')); await settle()
    // The blob is the real ECIES output: 1 + 65 + 12 + (1+6+1+2) + 16 bytes.
    const bytes = Uint8Array.from(atob(m.addWifi.mock.calls[0]![1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    expect(bytes.length).toBe(1 + 65 + 12 + 10 + 16); expect(bytes[0]).toBe(1)
  })
  it('walks Sending, connecting, Connected from the command log', async () => {
    vi.useFakeTimers()
    let release: (v: { command_id: string }) => void = () => {}
    m.addWifi.mockReturnValue(new Promise((resolve) => { release = resolve }))
    await open(); await fill('Office', 'pw')
    await sendIt()
    expect(host.textContent).toContain('Sending to Aelys…')
    await act(async () => release({ command_id: 'cmd1' }))
    expect(host.textContent).toContain('Aelys is connecting…')
    m.state.mockResolvedValue(baseState({ command_log: [entry({ ok: null })] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.textContent).toContain('Aelys is connecting…')
    m.state.mockResolvedValue(baseState({ command_log: [entry({ ok: true })], wifi: { saved: ['Home', 'Office', 'Cafe'], current: 'Office' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.textContent).toContain('Connected to Office')
    expect(host.textContent).not.toContain('Aelys is connecting…')
  })
  it('adds the new network to the list once it connected', async () => {
    vi.useFakeTimers()
    await open(); await fill('Brand New', 'pw')
    await sendIt()
    m.state.mockResolvedValue(baseState({ command_log: [entry({ ok: true })] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect([...host.querySelectorAll('[data-testid="wifi-row"]')].map((r) => r.textContent).join('|')).toContain('Brand New')
  })
  it('wrong password state from command_log', async () => {
    vi.useFakeTimers()
    await open(); await fill('Office', 'pw')
    await sendIt()
    m.state.mockResolvedValue(baseState({ command_log: [entry({ ok: false, error_code: 'WIFI_FAILED' })] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.textContent).toContain('Wrong password for Office')
    expect(host.textContent).toContain('Aelys is still on Home. Nothing else changed')
    await click(button('Try again'))
    expect(byLabel<HTMLInputElement>('Network name').value).toBe('Office')
    expect(byLabel<HTMLInputElement>('Password').value).toBe('')
  })
  it('wrong password: Remove deletes the network', async () => {
    vi.useFakeTimers()
    await open(); await fill('Office', 'pw')
    await sendIt()
    m.state.mockResolvedValue(baseState({ command_log: [entry({ ok: false, error_code: 'WIFI_FAILED' })] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!)
    expect(m.removeWifi).toHaveBeenCalledWith(ID, 'Office')
    expect(host.textContent).not.toContain('Wrong password')
  })
  it('DECRYPT_FAILED and a timeout are a generic failure, not a wrong password', async () => {
    vi.useFakeTimers()
    await open(); await fill('Office', 'pw')
    await sendIt()
    m.state.mockResolvedValue(baseState({ command_log: [entry({ ok: false, error_code: 'DECRYPT_FAILED' })] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.textContent).toContain("Couldn't add Office"); expect(host.textContent).not.toContain('Wrong password')
    await click(button('Try again')); await fill('Office', 'pw')
    m.state.mockResolvedValue(baseState({ command_log: [] }))
    await sendIt()
    for (let i = 0; i < 31; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(host.textContent).toContain("Couldn't add Office")
  })
  it('stops waiting when the page is left', async () => {
    vi.useFakeTimers()
    await open(); await fill('Office', 'pw')
    await sendIt()
    act(() => root.unmount())
    const before = m.state.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(m.state.mock.calls.length).toBe(before)
  })
  it('needs a network name to send', async () => {
    await open(); expect(button('Send to Aelys').disabled).toBe(true)
  })
  it('Escape closes the sheet without sending', async () => {
    await open()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(m.addWifi).not.toHaveBeenCalled()
  })
})

describe('Device settings', () => {
  it('shows brightness, the static notifications row, the firmware version, and none of the rows without firmware', async () => {
    await mount('settings')
    const text = host.textContent!
    for (const part of ['Brightness', '70%', 'Notifications on Aelys', 'Tasks, Calendar, Focus', 'Titles only · always', 'Firmware', 'Version 1.0.0', 'Restart Aelys', 'Takes about 10 seconds', 'Unpair Aelys', 'Erases Aelys, its saved Wi-Fi and contacts. Requires your fingerprint']) expect(text).toContain(part)
    for (const gone of ['Sleep after', 'Night hours', 'Sounds', 'Emotions', 'Other apps', 'Update automatically', 'Update now', 'Name']) expect(text).not.toContain(gone)
    const slider = byLabel<HTMLInputElement>('Brightness')
    expect(slider.min).toBe('5'); expect(slider.max).toBe('100'); expect(slider.value).toBe('70')
  })
  it('brightness debounced', async () => {
    vi.useFakeTimers()
    await mount('settings')
    const slider = byLabel<HTMLInputElement>('Brightness')
    await type(slider, '30'); await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await type(slider, '40'); await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(m.setSettings).not.toHaveBeenCalled(); expect(host.textContent).toContain('40%')
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(m.setSettings).toHaveBeenCalledTimes(1); expect(m.setSettings).toHaveBeenCalledWith(ID, { brightness: 40 })
  })
  it('sends a pending brightness when the page is left, and reports offline', async () => {
    vi.useFakeTimers()
    await mount('settings'); await type(byLabel('Brightness'), '20')
    act(() => root.unmount())
    expect(m.setSettings).toHaveBeenCalledWith(ID, { brightness: 20 })
  })
  it('shows "Aelys is offline" when the brightness cannot be sent', async () => {
    vi.useFakeTimers(); m.setSettings.mockRejectedValue(new ApiError(409, 'DEVICE_OFFLINE', 'offline'))
    await mount('settings'); await type(byLabel('Brightness'), '20')
    await act(async () => { await vi.advanceTimersByTimeAsync(450) })
    expect(host.textContent).toContain('Aelys is offline')
  })
  it('restart sends the command and says so', async () => {
    await mount('settings'); await click(button('Restart'))
    expect(m.restart).toHaveBeenCalledWith(ID); expect(host.textContent).toContain('Restarting…')
  })
  it('restart offline shows "Aelys is offline"', async () => {
    m.restart.mockRejectedValue(new ApiError(409, 'DEVICE_OFFLINE', 'offline'))
    await mount('settings'); await click(button('Restart'))
    expect(host.textContent).toContain('Aelys is offline')
  })
  it('unpair needs reauth', async () => {
    let release: (v: { challenge_id: string; signature: string }) => void = () => {}
    m.reauth.mockReturnValue(new Promise((resolve) => { release = resolve }))
    await mount('settings'); await click(button('Unpair'))
    expect(m.reauth).toHaveBeenCalledWith('unpair', ID)
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain("Confirm it's you")
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('Erases Aelys, its saved Wi-Fi and contacts')
    expect(m.unpair).not.toHaveBeenCalled()
    await act(async () => release({ challenge_id: 'ch1', signature: 'sig' }))
    expect(m.unpair).toHaveBeenCalledWith(ID, { challenge_id: 'ch1', signature: 'sig' })
    expect(window.location.search).toBe('?section=devices') // back to the Devices list
  })
  it('unpair cancel and a failed fingerprint send nothing', async () => {
    m.reauth.mockReturnValue(new Promise(() => {}))
    await mount('settings'); await click(button('Unpair')); await click(button('Cancel'))
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(m.unpair).not.toHaveBeenCalled()
    m.reauth.mockReset().mockRejectedValue(new Error('denied'))
    await click(button('Unpair'))
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(m.unpair).not.toHaveBeenCalled()
  })
  it('a failed unpair keeps the sheet and the page', async () => {
    m.unpair.mockRejectedValue(new Error('boom'))
    await mount('settings'); await click(button('Unpair'))
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(window.location.search).toContain('page=settings')
  })
})

describe('Navigation', () => {
  it('the overview rows open the new pages', async () => {
    await mount('overview')
    await click(button('Emergency')); expect(window.location.search).toContain('page=emergency'); expect(host.textContent).toContain('Emergency contacts')
    await click(byLabel('Back')); await click(button('Wi-Fi networks')); expect(host.textContent).toContain('Saved networks')
    await click(byLabel('Back')); await click(button('Device settings')); expect(host.textContent).toContain('Brightness')
  })
})
