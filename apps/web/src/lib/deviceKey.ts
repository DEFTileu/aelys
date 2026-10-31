// This browser's device identity: an ECDSA P-256 key the page can use but never read out.
// The private CryptoKey is created non-extractable and kept in IndexedDB; the server only ever sees the public key.

export interface DeviceIdentity {
  deviceId: string
  /** Server this key was registered with; an identity is never presented to another server. */
  origin: string
  publicKey: string
  privateKey: CryptoKey
}

export interface IdentityStore {
  load(): Promise<DeviceIdentity | undefined>
  save(identity: DeviceIdentity): Promise<void>
  clear(): Promise<void>
}

const DB_NAME = 'aelys-device'
const STORE = 'identity'
const RECORD = 'current'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(database.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

export const indexedDbIdentityStore: IdentityStore = {
  load: async () => {
    try { return (await run<DeviceIdentity | undefined>('readonly', (store) => store.get(RECORD))) ?? undefined } catch { return undefined }
  },
  save: async (identity) => { await run('readwrite', (store) => store.put(identity, RECORD)) },
  clear: async () => { try { await run('readwrite', (store) => store.delete(RECORD)) } catch { /* nothing to clear */ } },
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface GeneratedKey { privateKey: CryptoKey; publicKey: string }

export async function generateDeviceKey(): Promise<GeneratedKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  // The uncompressed point is what the server stores; public keys stay exportable even when the private half is not.
  return { privateKey: pair.privateKey, publicKey: base64Url(await crypto.subtle.exportKey('raw', pair.publicKey)) }
}

/** ES256 signature as raw r||s, which the server accepts alongside DER. */
export async function signWithDeviceKey(privateKey: CryptoKey, message: string): Promise<string> {
  return base64Url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message)))
}

export function webCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined'
}
