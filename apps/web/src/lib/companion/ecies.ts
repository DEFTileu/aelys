import { base64Url } from '../deviceKey'

const enc = new TextEncoder()
const unb64 = (v: string) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export async function sha256Hex(s: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function newPairingSecret(): string { return base64Url(crypto.getRandomValues(new Uint8Array(32))) }

/**
 * Wi-Fi ECIES blob for the board: 0x01 | eph_pub(65) | nonce(12) | ciphertext | tag(16), base64url.
 * ECDH(eph, device) x -> HKDF-SHA256(salt = eph_pub | device_pub, info "aelys-wifi-v1") -> AES-256-GCM, AAD = device_id.
 */
export async function encryptWifi(devicePubB64: string, deviceId: string, ssid: string, password: string,
  testOnly?: { ephemeralJwk: JsonWebKey; nonce: Uint8Array }): Promise<string> {
  const ssidBytes = enc.encode(ssid); const passBytes = enc.encode(password)
  if (ssidBytes.length < 1 || ssidBytes.length > 32) throw new RangeError('Network name must be 1-32 bytes')
  if (passBytes.length > 64) throw new RangeError('Password must be at most 64 bytes')
  const plain = Uint8Array.from([ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes])

  const devicePub = unb64(devicePubB64)
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' }
  const devicePubKey = await crypto.subtle.importKey('raw', devicePub, ecdh, false, [])
  const ephJwk = testOnly?.ephemeralJwk ?? await crypto.subtle.exportKey('jwk', (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])).privateKey)
  const ephPriv = await crypto.subtle.importKey('jwk', ephJwk, ecdh, false, ['deriveBits'])
  const ephPub = Uint8Array.from([4, ...unb64(ephJwk.x!), ...unb64(ephJwk.y!)])

  const z = await crypto.subtle.deriveBits({ name: 'ECDH', public: devicePubKey }, ephPriv, 256)
  const ikm = await crypto.subtle.importKey('raw', z, 'HKDF', false, ['deriveBits'])
  const salt = Uint8Array.from([...ephPub, ...devicePub])
  const keyBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('aelys-wifi-v1') }, ikm, 256)
  const key = await crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt'])
  const nonce = testOnly?.nonce ?? crypto.getRandomValues(new Uint8Array(12))
  let sealed: Uint8Array
  try {
    sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: Uint8Array.from(nonce), additionalData: enc.encode(deviceId) }, key, plain))
  } finally { plain.fill(0); ssidBytes.fill(0); passBytes.fill(0) } // the password must not linger in memory
  return base64Url(Uint8Array.from([1, ...ephPub, ...nonce, ...sealed]))
}
