import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImprovParser, improvFrame, resultStrings, rpc } from '../lib/companion/improv'
import { CompanionError, CompanionSerial } from '../lib/companion/serial'

// Same bytes as firmware/companion/sim/test_improv.c::test_build_then_parse_roundtrip.
const VECTOR = Uint8Array.from([0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56, 1, 4, 4, 1, 2, 3, 250, 0xe6])
const enc = (s: string) => new TextEncoder().encode(s)
const frame = (type: number, ...data: number[]) => improvFrame(type, Uint8Array.from(data))
const result = (cmd: number, strings: string[]) => improvFrame(4, rpc(cmd, strings))
const concat = (...a: Uint8Array[]) => Uint8Array.from(a.flatMap((x) => [...x]))

/** Fake port: `reply` sees each written RPC frame and returns the bytes the board answers with. */
function fakePort(reply: (written: Uint8Array) => Uint8Array[]) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const written: Uint8Array[] = []
  const port = {
    readable: new ReadableStream<Uint8Array>({ start: (c) => { ctl = c } }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) { written.push(chunk); for (const r of reply(chunk)) queueMicrotask(() => ctl.enqueue(r)) },
    }),
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  return { port: port as unknown as SerialPort, written, push: (b: Uint8Array) => ctl.enqueue(b) }
}
const clear = frame(2, 0)

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Improv framing', () => {
  it('frame bytes match firmware test vector', () => {
    expect(improvFrame(4, Uint8Array.from([1, 2, 3, 250]))).toEqual(VECTOR)
    expect(new ImprovParser().push(VECTOR)).toEqual([{ type: 4, data: Uint8Array.from([1, 2, 3, 250]) }])
  })

  it('parser skips log lines and split chunks', () => {
    const p = new ImprovParser()
    const bytes = concat(enc('I (123) boot: hello IMPROV?\r\n'), VECTOR, enc('log\r\n'), frame(1, 4))
    const out = [...bytes].flatMap((b) => p.push(Uint8Array.of(b)))
    expect(out.map((x) => x.type)).toEqual([4, 1])
    expect(new ImprovParser().push(concat(enc('IMPROVIMPROV'), VECTOR))).toHaveLength(1)
  })

  it('bad checksum resets', () => {
    const bad = VECTOR.slice(); bad[bad.length - 1] ^= 0x55
    expect(new ImprovParser().push(concat(bad, VECTOR))).toHaveLength(1)
  })

  it('rpc and resultStrings round trip', () => {
    expect(rpc(0xa0, ['ab', 'c'])).toEqual(Uint8Array.from([0xa0, 5, 2, 97, 98, 1, 99]))
    const p = new ImprovParser().push(result(0xa3, ['paired', 'id']))[0]
    expect(resultStrings(p)).toEqual({ cmd: 0xa3, strings: ['paired', 'id'] })
  })
})

describe('CompanionSerial', () => {
  it('supported() false without navigator.serial', () => {
    vi.stubGlobal('navigator', {})
    expect(CompanionSerial.supported()).toBe(false)
    vi.stubGlobal('navigator', { serial: {} })
    expect(CompanionSerial.supported()).toBe(true)
  })

  it('pairBegin over a fake port resolves the key', async () => {
    const f = fakePort((w) => {
      expect(new ImprovParser().push(w)[0].data).toEqual(rpc(0xa0, ['s'.repeat(32), 'https://api']))
      return [concat(enc('I (1) log\r\n'), clear, result(0xa0, ['PUBKEY']))]
    })
    const c = await CompanionSerial.fromPort(f.port)
    expect(f.port.open).toHaveBeenCalledWith({ baudRate: 115200 })
    expect(await c.pairBegin('s'.repeat(32), 'https://api')).toBe('PUBKEY')
    await c.close()
  })

  it('info checks the firmware name', async () => {
    let name = 'aelys-companion'
    const f = fakePort(() => [clear, result(3, [name, '1.2', 'ESP32-S3', 'Aelys'])])
    const c = await CompanionSerial.fromPort(f.port)
    expect(await c.info()).toEqual({ firmware: 'aelys-companion', version: '1.2' })
    name = 'other'
    await expect(c.info()).rejects.toMatchObject({ code: 'NOT_AELYS' })
  })

  it('maps error 0x80 to LOST_MODE and 0x81 to NOT_PENDING', async () => {
    let code = 0x80
    const f = fakePort(() => [clear, frame(2, code)])
    const c = await CompanionSerial.fromPort(f.port)
    await expect(c.pairCode('id')).rejects.toMatchObject({ code: 'LOST_MODE' })
    code = 0x81
    await expect(c.pairCommit('a'.repeat(36))).rejects.toMatchObject({ code: 'NOT_PENDING' })
    code = 0x82
    await expect(c.pairCommit('a'.repeat(36))).rejects.toMatchObject({ code: 'PAIR_BUSY' })
    code = 0x01
    await expect(c.pairCode('id')).rejects.toBeInstanceOf(CompanionError)
  })

  it('timeout maps to TIMEOUT', async () => {
    vi.useFakeTimers()
    const c = await CompanionSerial.fromPort(fakePort(() => []).port)
    const p = c.pairStatus()
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('pairStatus, state and sendWifi', async () => {
    const f = fakePort((w) => {
      const d = new ImprovParser().push(w)[0].data
      if (d[0] === 0xa3) return [clear, result(0xa3, ['paired', 'dev-id'])]
      if (d[0] === 2) return [clear, frame(1, 4)]
      return d[2] === 3
        ? [clear, frame(1, 3), frame(2, 3), frame(1, 2)] // bad password
        : [clear, frame(1, 3), frame(1, 4), result(1, [])]
    })
    const c = await CompanionSerial.fromPort(f.port)
    expect(await c.pairStatus()).toEqual({ paired: true, deviceId: 'dev-id' })
    expect(await c.state()).toBe('provisioned')
    expect(await c.sendWifi('home', 'pw')).toBe('ok')
    expect(await c.sendWifi('bad', 'pw')).toBe('bad_password')
  })

  it('runs one request at a time', async () => {
    const order: number[] = []
    const f = fakePort((w) => { const cmd = new ImprovParser().push(w)[0].data[0]; order.push(cmd); return [result(cmd, [])] })
    const c = await CompanionSerial.fromPort(f.port)
    await Promise.all([c.pairCode('a'), c.pairCommit('b'.repeat(36))])
    expect(order).toEqual([0xa1, 0xa2])
  })

  it('an oversized request fails alone and does not kill the next one', async () => {
    vi.useFakeTimers()
    const f = fakePort(() => [])
    const c = await CompanionSerial.fromPort(f.port)
    await expect(c.pairBegin('x'.repeat(300), 'u')).rejects.toMatchObject({ code: 'BAD_ARGS' })
    const wifi = c.sendWifi('home', 'pw')
    await vi.advanceTimersByTimeAsync(6000) // past the failed call's would-be 5 s timer
    f.push(concat(clear, frame(1, 4), result(1, [])))
    await expect(wifi).resolves.toBe('ok')
  })

  it('sendWifi consumes its trailing frame so state() is not answered by it', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0))
    const cases: [Uint8Array[], Uint8Array, string][] = [
      [[clear, frame(2, 3)], frame(1, 2), 'bad_password'], // ERROR 0x03, then STATE 0x02 in its own chunk
      [[clear, frame(1, 4)], result(1, []), 'ok'], // STATE 0x04, then RESULT in its own chunk
    ]
    for (const [first, trailing, want] of cases) {
      const f = fakePort(() => [])
      const c = await CompanionSerial.fromPort(f.port)
      const wifi = c.sendWifi('home', 'pw')
      const state = c.state() // queued right behind it
      await tick()
      for (const chunk of first) f.push(chunk)
      await tick()
      f.push(trailing)
      expect(await wifi).toBe(want)
      await tick()
      f.push(frame(1, 4)) // the board's answer to state()
      expect(await state).toBe('provisioned')
    }
  })

  it('state() rejects an unknown STATE byte', async () => {
    const f = fakePort(() => [clear, frame(1, 9)])
    const c = await CompanionSerial.fromPort(f.port)
    await expect(c.state()).rejects.toMatchObject({ code: 'BAD_ARGS' })
  })
})
