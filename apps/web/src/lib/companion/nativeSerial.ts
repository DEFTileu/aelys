import { isNativeHost } from '../nativeTransport'
import { CompanionError } from './improv'

/** The Mac app only (Android has its own host without this bridge); WKWebView has no Web Serial. */
export const nativeSerialHost = () => isNativeHost() && !/Android/i.test(navigator.userAgent)

let core: Promise<typeof import('@tauri-apps/api/core')> | undefined
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await (core ??= import('@tauri-apps/api/core'))
  return invoke<T>(command, args)
}

/**
 * A minimal SerialPort over the Rust bridge (companion_serial_*), so CompanionSerial.fromPort works
 * unchanged. Rust only opens the Aelys board and only writes whole Improv RPC frames.
 */
export class NativeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  private stopped = false
  private inflight: Promise<unknown> = Promise.resolve()

  private constructor(private path: string) {}

  /** The Aelys board. With several attached, the first one. */
  static async pick(): Promise<NativeSerialPort> {
    const [path] = await call<string[]>('companion_serial_ports')
    if (!path) throw new CompanionError('NOT_AELYS')
    return new NativeSerialPort(path)
  }

  // The baud rate is meaningless for USB CDC; Rust fixes it.
  async open(_options: { baudRate: number }): Promise<void> {
    await call<void>('companion_serial_open', { path: this.path })
    this.stopped = false
    this.readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        // Poll until bytes arrive: a pull that enqueues nothing would not be called again.
        while (!this.stopped) {
          try {
            const read = call<number[]>('companion_serial_read', { max: 512 })
            this.inflight = read.catch(() => undefined)
            const bytes = await read
            if (bytes.length) { controller.enqueue(Uint8Array.from(bytes)); return }
          } catch { // DISCONNECTED or the port is gone
            if (!this.stopped) controller.error(new CompanionError('DISCONNECTED'))
            return
          }
        }
      },
      cancel: () => { this.stopped = true },
    })
    this.writable = new WritableStream<Uint8Array>({
      write: async (frame) => {
        try { await call<void>('companion_serial_write', { bytes: Array.from(frame) }) } catch { throw new CompanionError('DISCONNECTED') }
      },
    })
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.inflight // let the last poll finish so Rust can release the port
    await call<void>('companion_serial_close')
  }
}
