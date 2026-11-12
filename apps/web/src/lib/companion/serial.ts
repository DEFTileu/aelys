import { isNativeHost } from '../nativeTransport'
import { CompanionError, ImprovParser, improvFrame, resultStrings, rpc, type ImprovPacket } from './improv'

export { CompanionError }

const T_STATE = 0x01, T_ERROR = 0x02, T_RPC = 0x03
const ERRORS: Record<number, CompanionError['code']> = { 0x80: 'LOST_MODE', 0x81: 'NOT_PENDING' }

// Returns a value to finish the request, undefined to keep waiting, or throws.
type Handler<T> = (p: ImprovPacket) => T | undefined

export class CompanionSerial {
  private parser = new ImprovParser()
  private handler: ((p: ImprovPacket) => void) | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private reader: ReadableStreamDefaultReader<Uint8Array>

  private constructor(private port: SerialPort) {
    if (!port.readable || !port.writable) throw new CompanionError('UNSUPPORTED_BROWSER', 'Port is not readable/writable')
    this.writer = port.writable.getWriter()
    this.reader = port.readable.getReader()
    void this.pump()
  }

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.serial && !isNativeHost()
  }

  static async request(): Promise<CompanionSerial> {
    if (!CompanionSerial.supported()) throw new CompanionError('UNSUPPORTED_BROWSER')
    return CompanionSerial.fromPort(await navigator.serial!.requestPort()) // no filters: USB-Serial/JTAG
  }

  static async fromPort(port: SerialPort): Promise<CompanionSerial> {
    await port.open({ baudRate: 115200 })
    return new CompanionSerial(port)
  }

  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) return
        for (const p of this.parser.push(value)) this.handler?.(p)
      }
    } catch { /* port closed or unplugged: pending requests time out */ }
  }

  private call<T>(cmd: number, strings: string[], ms: number, onPacket: Handler<T>): Promise<T> {
    const run = () => new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(timer); this.handler = null; fn() }
      const timer = setTimeout(() => done(() => reject(new CompanionError('TIMEOUT'))), ms)
      this.handler = (p) => {
        try {
          if (p.type === T_ERROR && p.data[0] === 0) return // the board's "clear error" precedes every answer
          const v = onPacket(p)
          if (v !== undefined) done(() => resolve(v))
        } catch (e) { done(() => reject(e)) }
      }
      this.writer.write(improvFrame(T_RPC, rpc(cmd, strings))).catch((e) => done(() => reject(e)))
    })
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private static fail(p: ImprovPacket): never {
    throw new CompanionError(ERRORS[p.data[0]] ?? 'BAD_ARGS')
  }

  /** RPC whose answer is a RESULT for the same command. */
  private result(cmd: number, strings: string[] = [], ms = 5000): Promise<string[]> {
    return this.call(cmd, strings, ms, (p) => {
      if (p.type === T_ERROR) CompanionSerial.fail(p)
      if (p.type !== 0x04) return undefined
      const r = resultStrings(p)
      return r.cmd === cmd ? r.strings : undefined
    })
  }

  async info(): Promise<{ firmware: string; version: string }> {
    const [firmware, version] = await this.result(0x03)
    if (firmware !== 'aelys-companion') throw new CompanionError('NOT_AELYS')
    return { firmware, version: version ?? '' }
  }

  state(): Promise<'authorized' | 'provisioning' | 'provisioned'> {
    const names = { 2: 'authorized', 3: 'provisioning', 4: 'provisioned' } as const
    return this.call(0x02, [], 5000, (p) => {
      if (p.type === T_ERROR) CompanionSerial.fail(p)
      return p.type === T_STATE ? names[p.data[0] as 2 | 3 | 4] : undefined
    })
  }

  async pairBegin(secret: string, apiUrl: string): Promise<string> {
    const [key] = await this.result(0xa0, [secret, apiUrl])
    if (!key) throw new CompanionError('BAD_ARGS', 'No public key in answer')
    return key
  }

  async pairCode(pairingId: string): Promise<void> { await this.result(0xa1, [pairingId]) }
  async pairCommit(deviceId: string): Promise<void> { await this.result(0xa2, [deviceId]) }

  async pairStatus(): Promise<{ paired: boolean; deviceId?: string }> {
    const [status, deviceId] = await this.result(0xa3)
    return status === 'paired' ? { paired: true, deviceId } : { paired: false }
  }

  sendWifi(ssid: string, password: string): Promise<'ok' | 'bad_password'> {
    return this.call(0x01, [ssid, password], 20000, (p) => {
      if (p.type === T_ERROR) return p.data[0] === 0x03 ? 'bad_password' as const : CompanionSerial.fail(p)
      return p.type === T_STATE && p.data[0] === 0x04 ? 'ok' as const : undefined
    })
  }

  async close(): Promise<void> {
    this.handler = null
    await this.reader.cancel().catch(() => undefined)
    this.reader.releaseLock()
    await this.writer.close().catch(() => undefined)
    await this.port.close().catch(() => undefined)
  }
}
