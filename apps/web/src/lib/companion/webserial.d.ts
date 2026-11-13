// Minimal Web Serial typings (not in lib.dom). Only what the companion client uses.
export {}
declare global {
  interface SerialPort {
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
    open(options: { baudRate: number }): Promise<void>
    setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>
    close(): Promise<void>
  }
  interface Serial {
    requestPort(options?: object): Promise<SerialPort>
  }
  interface Navigator {
    readonly serial?: Serial
  }
}
