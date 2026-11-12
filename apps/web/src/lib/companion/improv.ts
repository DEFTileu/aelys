// Improv Serial v1 framing, byte-compatible with firmware/companion/components/logic/improv.c.
const HDR = [0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56] // "IMPROV"
const VERSION = 1

export type ImprovPacket = { type: number; data: Uint8Array }
export type ErrorCode = 'NOT_AELYS' | 'LOST_MODE' | 'NOT_PENDING' | 'TIMEOUT' | 'BAD_ARGS' | 'UNSUPPORTED_BROWSER'

export class CompanionError extends Error {
  constructor(public code: ErrorCode, message: string = code) {
    super(message)
    this.name = 'CompanionError'
  }
}

export function improvFrame(type: number, data: Uint8Array): Uint8Array {
  if (data.length > 255) throw new CompanionError('BAD_ARGS', 'Improv payload too long')
  const out = new Uint8Array(10 + data.length)
  out.set(HDR)
  out[6] = VERSION
  out[7] = type
  out[8] = data.length
  out.set(data, 9)
  out[9 + data.length] = out.subarray(0, 9 + data.length).reduce((a, b) => (a + b) & 0xff, 0)
  return out
}

/** Port of improv_feed: skips log text between frames, resets on a bad checksum. */
export class ImprovParser {
  private st: 'hdr' | 'ver' | 'type' | 'len' | 'data' | 'sum' = 'hdr'
  private idx = 0
  private sum = 0
  private type = 0
  private data = new Uint8Array(0)

  push(bytes: Uint8Array): ImprovPacket[] {
    const out: ImprovPacket[] = []
    for (const b of bytes) {
      switch (this.st) {
        case 'hdr':
          if (b === HDR[this.idx]) {
            this.sum += b
            if (++this.idx === HDR.length) this.st = 'ver'
          } else this.restart(b)
          break
        case 'ver':
          if (b !== VERSION) this.restart(b)
          else { this.sum += b; this.st = 'type' }
          break
        case 'type':
          this.type = b; this.sum += b; this.st = 'len'
          break
        case 'len':
          this.sum += b; this.idx = 0; this.data = new Uint8Array(b)
          this.st = b ? 'data' : 'sum'
          break
        case 'data':
          this.data[this.idx++] = b; this.sum += b
          if (this.idx === this.data.length) this.st = 'sum'
          break
        case 'sum':
          if (b === (this.sum & 0xff)) out.push({ type: this.type, data: this.data })
          this.restart()
      }
    }
    return out
  }

  // The mismatching byte may itself start a header ("IMPROVIMPROV").
  private restart(b?: number) {
    this.st = 'hdr'; this.idx = 0; this.sum = 0
    if (b === HDR[0]) { this.sum = b; this.idx = 1 }
  }
}

/** RPC data: [cmd][len of the rest]([len][utf8])... */
export function rpc(cmd: number, strings: string[]): Uint8Array {
  const parts = strings.map((s) => new TextEncoder().encode(s))
  const body = parts.reduce((n, p) => n + 1 + p.length, 0)
  if (parts.some((p) => p.length > 255) || body > 253) throw new CompanionError('BAD_ARGS', 'RPC too long')
  const out = new Uint8Array(2 + body)
  out[0] = cmd
  out[1] = body
  let i = 2
  for (const p of parts) { out[i++] = p.length; out.set(p, i); i += p.length }
  return out
}

export function resultStrings(p: ImprovPacket): { cmd: number; strings: string[] } {
  const d = p.data
  if (p.type !== 0x04 || d.length < 2 || d[1] !== d.length - 2) throw new CompanionError('BAD_ARGS', 'Malformed RESULT')
  const strings: string[] = []
  for (let i = 2; i < d.length;) {
    const l = d[i]
    if (i + 1 + l > d.length) throw new CompanionError('BAD_ARGS', 'Malformed RESULT')
    strings.push(new TextDecoder().decode(d.subarray(i + 1, i + 1 + l)))
    i += 1 + l
  }
  return { cmd: d[0], strings }
}
