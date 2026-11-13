import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@aelys/shared'
import { CompanionError } from '../lib/companion/serial'
import { DevicesPanel } from '../views/settings/devices/DevicesPanel'
import { GROUPS } from '../views/settings/useSettings'

const m = vi.hoisted(() => ({
  base: 'https://aelys.example/api/v1', calls: [] as string[], supported: true,
  board: { pairStatus: vi.fn(), info: vi.fn(), state: vi.fn(), pairBegin: vi.fn(), pairCode: vi.fn(), pairCommit: vi.fn(), sendWifi: vi.fn(), close: vi.fn() },
  request: vi.fn(), requestPairing: vi.fn(), approve: vi.fn(), newSecret: vi.fn(),
}))
vi.mock('../lib/companion/serial', async (original) => ({ ...(await original<typeof import('../lib/companion/serial')>()), CompanionSerial: { supported: () => m.supported, request: m.request } }))
vi.mock('../lib/companion/api', () => ({ companion: { requestPairing: m.requestPairing, approve: m.approve }, newPairingSecret: m.newSecret, sha256Hex: async (s: string) => `hash:${s}` }))
vi.mock('../lib/api', () => ({ getApiConfig: () => ({ baseUrl: m.base }) }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const flush = () => act(async () => { await Promise.resolve() })
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<div className="st"><DevicesPanel /></div>)) }
const setValue = (el: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
async function typeCode(code: string) { const boxes = [...host.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')]; expect(boxes).toHaveLength(6); for (const [i, box] of boxes.entries()) await setValue(box, code[i]!) }
const track = (name: string, value: unknown) => vi.fn(async (...args: unknown[]) => { m.calls.push(name); void args; return value })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  m.base = 'https://aelys.example/api/v1'; m.supported = true; m.calls = []
  m.newSecret.mockReset().mockReturnValueOnce('S1').mockReturnValueOnce('S2').mockReturnValue('S3')
  m.request.mockReset().mockResolvedValue(m.board)
  m.board.info.mockReset().mockResolvedValue({ firmware: 'aelys-companion', version: '1' })
  m.board.state.mockReset().mockResolvedValue('authorized')
  m.board.pairBegin.mockReset().mockImplementation(track('pairBegin', 'PUB'))
  m.board.pairCode.mockReset().mockImplementation(track('pairCode', undefined))
  m.board.pairCommit.mockReset().mockImplementation(track('pairCommit', undefined))
  m.board.sendWifi.mockReset().mockResolvedValue('ok')
  m.board.pairStatus.mockReset().mockResolvedValue({ paired: false })
  m.board.close.mockReset().mockResolvedValue(undefined)
  m.requestPairing.mockReset().mockImplementation(track('requestPairing', { pairing_id: 'pid-1' }))
  m.approve.mockReset().mockImplementation(track('approve', { device_id: 'aaaaaaaa-0000-4000-8000-000000000001' }))
})
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('Add companion', () => {
  it('happy path calls pairBegin → requestPairing → pairCode → approve → pairCommit in order with the same secret', async () => {
    await mount()
    await act(async () => button('Connect Aelys').click())
    expect(host.textContent).toContain('Aelys found on USB')
    expect(host.textContent).toContain('Make sure it matches the 6 digits on the round screen')
    await typeCode('482913')
    await act(async () => button('Pair').click())
    expect(m.calls).toEqual(['pairBegin', 'requestPairing', 'pairCode', 'approve', 'pairCommit'])
    expect(m.board.pairBegin).toHaveBeenCalledWith('S1', 'https://aelys.example/api/v1')
    expect(m.requestPairing).toHaveBeenCalledWith('hash:S1', 'PUB')
    expect(m.board.pairCode).toHaveBeenCalledWith('pid-1')
    expect(m.approve).toHaveBeenCalledWith('pid-1', 'S1', '482913')
    expect(m.board.pairCommit).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001')
    expect(host.textContent).toContain('Choose Wi-Fi')
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="Network name"]')!, 'Office')
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!, 'hunter22')
    await act(async () => button('Send to Aelys').click())
    expect(m.board.sendWifi).toHaveBeenCalledWith('Office', 'hunter22')
    expect(host.textContent).toContain('Aelys is online')
    expect(m.board.close).toHaveBeenCalled()
    expect(host.textContent).toContain('Pairing works only over USB, so nobody can pair Aelys from afar.')
  })

  it('reports a wrong Wi-Fi password and keeps the form', async () => {
    m.board.sendWifi.mockResolvedValue('bad_password')
    await mount(); await act(async () => button('Connect Aelys').click()); await typeCode('111111'); await act(async () => button('Pair').click())
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="Network name"]')!, 'Office')
    await setValue(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!, 'nope')
    await act(async () => button('Send to Aelys').click())
    expect(host.textContent).toContain('Wrong password for Office')
    expect(host.querySelector('input[aria-label="Password"]')).not.toBeNull()
  })

  it('skips Wi-Fi when Aelys is already online', async () => {
    m.board.state.mockResolvedValue('provisioned')
    await mount(); await act(async () => button('Connect Aelys').click()); await typeCode('111111'); await act(async () => button('Pair').click())
    expect(host.textContent).toContain('Aelys is already online')
    expect(host.querySelector('input[aria-label="Network name"]')).toBeNull()
  })

  it('sas mismatch restarts with a new secret', async () => {
    m.approve.mockImplementationOnce(async () => { throw new ApiError(400, 'SAS_MISMATCH', 'no') })
    await mount(); await act(async () => button('Connect Aelys').click()); await typeCode('123456'); await act(async () => button('Pair').click())
    expect(host.textContent).toContain("The code doesn't match. Check the digits on Aelys and try again.")
    expect(m.board.pairBegin.mock.calls.map((c) => c[0])).toEqual(['S1', 'S2'])
    expect(m.requestPairing).toHaveBeenLastCalledWith('hash:S2', 'PUB')
    expect([...host.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')].map((i) => i.value)).toEqual(['', '', '', '', '', ''])
    await typeCode('654321'); await act(async () => button('Pair').click())
    expect(m.approve).toHaveBeenLastCalledWith('pid-1', 'S2', '654321')
  })

  it('restarts step 2 when the pairing expired', async () => {
    m.approve.mockImplementationOnce(async () => { throw new ApiError(410, 'PAIRING_EXPIRED', 'late') })
    await mount(); await act(async () => button('Connect Aelys').click()); await typeCode('123456'); await act(async () => button('Pair').click())
    expect(m.board.pairBegin).toHaveBeenCalledTimes(2)
    expect(host.querySelectorAll('input[inputmode="numeric"]')).toHaveLength(6)
  })

  it('lost mode error shows the message', async () => {
    m.board.pairBegin.mockRejectedValue(new CompanionError('LOST_MODE'))
    await mount(); await act(async () => button('Connect Aelys').click()); await flush()
    expect(host.textContent).toContain('Aelys is in lost mode. Turn lost mode off before pairing it again.')
    expect(host.querySelector('input[inputmode="numeric"]')).toBeNull()
    expect(m.board.close).toHaveBeenCalled()
  })

  it('refuses a board that is not Aelys', async () => {
    m.board.info.mockRejectedValue(new CompanionError('NOT_AELYS'))
    await mount(); await act(async () => button('Connect Aelys').click())
    expect(host.textContent).toContain('This USB device is not Aelys.')
    expect(m.board.pairBegin).not.toHaveBeenCalled()
  })

  it('no Web Serial shows the hint', async () => {
    m.supported = false
    await mount()
    expect(host.textContent).toContain('To add a companion, connect it by USB to Aelys on your Mac or on the web.')
    expect(host.textContent).not.toContain('Connect Aelys by USB-C')
    expect(host.querySelector('button')).toBeNull()
  })

  it('http backend is refused', async () => {
    m.base = 'http://aelys.example/api/v1'
    await mount()
    expect(host.textContent).toContain('Aelys needs a secure (https) backend')
    expect(host.querySelector('button')).toBeNull()
    expect(m.request).not.toHaveBeenCalled()
  })

  const DEV = 'aaaaaaaa-0000-4000-8000-000000000001'
  const pairWith = async () => { await mount(); await act(async () => button('Connect Aelys').click()); await typeCode('123456'); await act(async () => button('Pair').click()) }

  it('continues to Wi-Fi when a timed-out commit shows the board is paired with the same device', async () => {
    m.board.pairCommit.mockRejectedValueOnce(new CompanionError('TIMEOUT'))
    m.board.pairStatus.mockResolvedValue({ paired: true, deviceId: DEV })
    await pairWith()
    expect(m.board.pairCommit).toHaveBeenCalledTimes(1)
    expect(m.board.pairBegin).toHaveBeenCalledTimes(1)
    expect(host.querySelector('input[aria-label="Network name"]')).not.toBeNull()
  })

  it('retries a timed-out commit once when the board is not paired', async () => {
    m.board.pairCommit.mockRejectedValueOnce(new CompanionError('TIMEOUT'))
    await pairWith()
    expect(m.board.pairCommit).toHaveBeenCalledTimes(2)
    expect(m.approve).toHaveBeenCalledTimes(1)
    expect(host.querySelector('input[aria-label="Network name"]')).not.toBeNull()
  })

  it('restarts with honest copy when the board lost the pairing (NOT_PENDING)', async () => {
    m.board.pairCommit.mockRejectedValueOnce(new CompanionError('NOT_PENDING'))
    await pairWith()
    expect(host.textContent).toContain('Aelys lost the pairing. Starting again.')
    expect(host.textContent).not.toContain('The code expired')
    expect(m.board.pairBegin.mock.calls.map((c) => c[0])).toEqual(['S1', 'S2'])
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="Digit 1"]'))
  })

  it('restarts after a second commit failure', async () => {
    m.board.pairCommit.mockRejectedValueOnce(new CompanionError('TIMEOUT')).mockRejectedValueOnce(new CompanionError('TIMEOUT'))
    await pairWith()
    expect(m.board.pairCommit).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Aelys lost the pairing. Starting again.')
    expect(m.board.pairBegin).toHaveBeenCalledTimes(2)
  })

  it('closes the port when the page is left while the chooser is open', async () => {
    let pick!: (b: typeof m.board) => void
    m.request.mockReturnValue(new Promise((resolve) => { pick = resolve }))
    await mount(); await act(async () => button('Connect Aelys').click())
    act(() => root.unmount())
    await act(async () => { pick(m.board) })
    expect(m.board.close).toHaveBeenCalled()
    expect(m.board.info).not.toHaveBeenCalled()
  })

  it('closes the port when the page is left during pairing', async () => {
    let answer!: (k: string) => void
    m.board.pairBegin.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    await mount(); await act(async () => button('Connect Aelys').click())
    act(() => root.unmount())
    await act(async () => { answer('PUB') })
    expect(m.board.close).toHaveBeenCalled()
    expect(m.requestPairing).not.toHaveBeenCalled()
  })

  it('treats a malformed backend address as not secure', async () => {
    m.base = 'http://[bad'
    await mount()
    expect(host.textContent).toContain('Aelys needs a secure (https) backend')
  })

  it('submits the code with Enter, reveals the password and limits the network name to 32 bytes', async () => {
    await mount(); await act(async () => button('Connect Aelys').click()); await typeCode('123456')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(m.approve).toHaveBeenCalledTimes(1)
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Network name"]')!
    await setValue(name, 'é'.repeat(17)); expect(name.value).toBe('')
    await setValue(name, 'é'.repeat(16)); expect(name.value).toBe('é'.repeat(16))
    const password = host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!
    expect(password.type).toBe('password')
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Show password"]')!.click())
    expect(password.type).toBe('text')
    expect(host.querySelector('button[aria-label="Hide password"]')).not.toBeNull()
  })

  it('devices nav item sits between Connection and Security', () => {
    const system = GROUPS.find((g) => g.title === 'System')!.items
    expect(system.map((i) => i.id)).toEqual(['accounts', 'connection', 'devices', 'security', 'about'])
    expect(system.find((i) => i.id === 'devices')).toMatchObject({ title: 'Devices', desc: 'Companions paired with Aelys', tone: 'violet' })
  })
})
