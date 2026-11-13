import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionError, ImprovParser, improvFrame, rpc } from '../lib/companion/improv'
import { CompanionSerial } from '../lib/companion/serial'
import { AddCompanion } from '../views/settings/devices/AddCompanion'

const PORT = '/dev/cu.usbmodem101'
const b = vi.hoisted(() => ({
  invoke: vi.fn(), out: [] as number[], written: [] as number[][], ports: [] as string[], unplugged: false,
  requestPairing: vi.fn(), approve: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: b.invoke }))
vi.mock('../lib/api', () => ({ getApiConfig: () => ({ baseUrl: 'https://aelys.example/api/v1' }) }))
vi.mock('../lib/companion/api', () => ({ companion: { requestPairing: b.requestPairing, approve: b.approve }, newPairingSecret: () => 'SECRET', sha256Hex: async (s: string) => `hash:${s}` }))

const text = (s: string) => new TextEncoder().encode(s)
const queue = (...frames: Uint8Array[]) => { for (const f of frames) b.out.push(...f) }
const result = (cmd: number, ...strings: string[]) => improvFrame(0x04, rpc(cmd, strings))
const state = (n: number) => improvFrame(0x01, Uint8Array.of(n))
const clear = () => improvFrame(0x02, Uint8Array.of(0))
function parse(bytes: number[]) {
  const [p] = new ImprovParser().push(Uint8Array.from(bytes))
  return { cmd: p.data[0] }
}
/** A board that answers like the firmware: clear-error, then the matching frame. */
function board(bytes: number[]) {
  b.written.push(bytes)
  const { cmd } = parse(bytes)
  if (cmd === 0x03) queue(clear(), text('boot log\r\n') as unknown as Uint8Array, result(0x03, 'aelys-companion', '1'))
  else if (cmd === 0xa0) queue(clear(), result(0xa0, 'PUBKEY'))
  else if (cmd === 0xa1 || cmd === 0xa2) queue(clear(), result(cmd))
  else if (cmd === 0x02) queue(clear(), state(2))
  else if (cmd === 0x01) queue(clear(), state(4), result(0x01, 'http://x'))
}

beforeEach(() => {
  b.out = []; b.written = []; b.ports = [PORT]; b.unplugged = false
  b.invoke.mockReset().mockImplementation(async (cmd: string, args?: { bytes?: number[]; max?: number }) => {
    if (cmd === 'companion_serial_ports') return b.ports
    if (cmd === 'companion_serial_write') { board(args!.bytes!); return }
    if (cmd === 'companion_serial_read') {
      if (b.unplugged) throw 'DISCONNECTED'
      if (b.out.length) return b.out.splice(0, args!.max)
      await new Promise((r) => setTimeout(r, 2))
      return []
    }
  })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
})
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.restoreAllMocks() })

describe('native serial bridge', () => {
  it('lowers RTS then DTR on a Web Serial port right after opening it', async () => {
    const order: string[] = []
    const port = {
      readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>(),
      open: vi.fn(async () => { order.push('open') }), close: vi.fn(async () => undefined),
      setSignals: vi.fn(async (s: object) => { order.push(JSON.stringify(s)) }),
    }
    await CompanionSerial.fromPort(port)
    expect(order).toEqual(['open', '{"requestToSend":false}', '{"dataTerminalReady":false}'])
  })

  it('treats a refused frame as BAD_ARGS, not as an unplug', async () => {
    const serial = await CompanionSerial.request()
    const base = b.invoke.getMockImplementation()!
    b.invoke.mockImplementation(async (cmd: string, args?: never) => { if (cmd === 'companion_serial_write') throw 'BAD_FRAME'; return base(cmd, args) })
    await expect(serial.pairBegin('s'.repeat(40), 'https://aelys.example/api/v1')).rejects.toMatchObject({ code: 'BAD_ARGS' })
    await serial.close()
  })

  it('native port round-trips a pairBegin through CompanionSerial', async () => {
    const serial = await CompanionSerial.request()
    expect(b.invoke).toHaveBeenCalledWith('companion_serial_open', { path: PORT })
    expect(await serial.pairBegin('s'.repeat(40), 'https://aelys.example/api/v1')).toBe('PUBKEY')
    expect(b.written).toHaveLength(1)
    expect(b.written[0].slice(0, 6)).toEqual([...text('IMPROV')])
    await serial.close()
    expect(b.invoke).toHaveBeenCalledWith('companion_serial_close', undefined)
  })

  it('unplug mid-request ends with an error and closes', async () => {
    const serial = await CompanionSerial.request()
    const pending = serial.pairBegin('s'.repeat(40), 'https://aelys.example/api/v1')
    b.unplugged = true
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await serial.close()
    expect(b.invoke).toHaveBeenCalledWith('companion_serial_close', undefined)
  })

  it('supported() is true on the Mac host and false on Android', () => {
    expect(CompanionSerial.supported()).toBe(true)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14)')
    expect(CompanionSerial.supported()).toBe(false)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    expect(CompanionSerial.supported()).toBe(false)
  })

  it('picks the first Aelys port, and reports NOT_AELYS when there is none', async () => {
    b.ports = ['/dev/cu.usbmodem1', '/dev/cu.usbmodem2']
    await (await CompanionSerial.request()).close()
    expect(b.invoke).toHaveBeenCalledWith('companion_serial_open', { path: '/dev/cu.usbmodem1' })
    b.ports = []
    await expect(CompanionSerial.request()).rejects.toEqual(expect.any(CompanionError))
    await expect(CompanionSerial.request()).rejects.toMatchObject({ code: 'NOT_AELYS' })
  })

  it('AddCompanion runs the pairing flow on the Mac host', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    b.requestPairing.mockResolvedValue({ pairing_id: 'pid-1' })
    b.approve.mockResolvedValue({ device_id: 'aaaaaaaa-0000-4000-8000-000000000001' })
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    const button = (t: string) => [...host.querySelectorAll('button')].find((x) => x.textContent === t)!
    const set = (el: HTMLInputElement, v: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
    // Poll through act so React flushes the updates the real (timer-driven) bridge produces.
    const until = async (check: () => void) => {
      for (let i = 0; i < 200; i++) { try { return check() } catch { await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) } }
      check()
    }
    try {
      await act(async () => root.render(createElement(AddCompanion)))
      await act(async () => button('Connect Aelys').click())
      await until(() => expect(host.querySelectorAll('input[inputmode="numeric"]')).toHaveLength(6))
      for (const [i, box] of [...host.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')].entries()) await set(box, '482913'[i])
      await act(async () => button('Pair').click())
      await until(() => expect(host.querySelector('input[aria-label="Network name"]')).not.toBeNull())
      await set(host.querySelector<HTMLInputElement>('input[aria-label="Network name"]')!, 'Office')
      await set(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!, 'hunter22')
      await act(async () => button('Send to Aelys').click())
      await until(() => expect(host.textContent).toContain('Aelys is online on Office'))
      expect(b.invoke).toHaveBeenCalledWith('companion_serial_close', undefined)
    } finally { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() }
  })
})
