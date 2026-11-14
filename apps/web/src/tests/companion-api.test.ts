import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import vectors from './fixtures/companion-vectors.json'
import { clearAccessToken, getSharedApiClient, setIdentityStore, signWithThisDevice } from '../lib/api'
import { generateDeviceKey, type DeviceIdentity, type IdentityStore } from '../lib/deviceKey'
import { companion, reauth } from '../lib/companion/api'
import { encryptWifi, newPairingSecret, sha256Hex } from '../lib/companion/ecies'

const unb64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('encryptWifi', () => {
  it('matches the Python vector', async () => {
    const blob = await encryptWifi(vectors.device_pub_b64, vectors.device_id, vectors.ssid, vectors.password,
      { ephemeralJwk: vectors.eph_jwk, nonce: unb64(vectors.nonce_b64) })
    expect(blob).toBe(vectors.blob_b64)
  })

  it('uses a fresh ephemeral key and nonce by default and stays within 192 bytes', async () => {
    const a = await encryptWifi(vectors.device_pub_b64, vectors.device_id, 'x'.repeat(32), 'p'.repeat(64))
    const b = await encryptWifi(vectors.device_pub_b64, vectors.device_id, 'x'.repeat(32), 'p'.repeat(64))
    expect(a).not.toBe(b)
    expect(unb64(a).length).toBeLessThanOrEqual(192)
  })

  it('zeroes the plaintext buffer once it is encrypted', async () => {
    let seen: Uint8Array | undefined
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => { seen = data as Uint8Array; return real(algorithm, key, data) })
    await encryptWifi(vectors.device_pub_b64, vectors.device_id, 'Office', 'hunter22')
    expect(seen).toBeInstanceOf(Uint8Array)
    expect(seen!.length).toBeGreaterThan(0)
    expect([...seen!].every((b) => b === 0)).toBe(true)
  })

  it('rejects ssid > 32 bytes, empty ssid or password > 64 bytes', async () => {
    await expect(encryptWifi(vectors.device_pub_b64, vectors.device_id, 'x'.repeat(33), 'pw')).rejects.toThrow(RangeError)
    await expect(encryptWifi(vectors.device_pub_b64, vectors.device_id, 'я'.repeat(17), 'pw')).rejects.toThrow(RangeError) // 34 bytes
    await expect(encryptWifi(vectors.device_pub_b64, vectors.device_id, '', 'pw')).rejects.toThrow(RangeError)
    await expect(encryptWifi(vectors.device_pub_b64, vectors.device_id, 'net', 'p'.repeat(65))).rejects.toThrow(RangeError)
  })
})

describe('signWithThisDevice', () => {
  it('refuses any context other than the two re-auth ones', async () => {
    await expect(signWithThisDevice('aelys-device-login-v1' as never, 'target')).rejects.toThrow(/context/i)
    await expect(signWithThisDevice('' as never, 'target')).rejects.toThrow(/context/i)
  })
})

describe('pairing helpers', () => {
  it('secret is 43 url-safe chars', () => {
    const secret = newPairingSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newPairingSecret()).not.toBe(secret)
  })
  it('sha256Hex("abc") is the known value', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('reauth', () => {
  let store: IdentityStore & { value?: DeviceIdentity }
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); clearAccessToken(false)
    vi.stubGlobal('indexedDB', {})
    store = { load: async () => store.value, save: async (i) => { store.value = i }, clear: async () => { store.value = undefined } }
    setIdentityStore(store)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it.each([['lost_off', 'aelys-companion-lost-off-v1'], ['unpair', 'aelys-companion-unpair-v1']] as const)(
    'signs the exact %s context string', async (purpose, context) => {
      const key = await generateDeviceKey()
      store.value = { deviceId: 'own-device', origin: window.location.origin, publicKey: key.publicKey, privateKey: key.privateKey }
      const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ challenge_id: 'ch-1', nonce: 'nonce-1', expires_at: 'soon' }))
      vi.stubGlobal('fetch', fetchMock)
      const result = await reauth(purpose, 'target-device')
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ device_id: 'own-device' })
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/device\/challenge$/)
      expect(result.challenge_id).toBe('ch-1')
      const pub = await crypto.subtle.importKey('raw', unb64(key.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      const verify = (message: string) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(result.signature), new TextEncoder().encode(message))
      expect(await verify(`${context}\ntarget-device\nnonce-1`)).toBe(true)
      expect(await verify(`aelys-device-login-v1\nown-device\nnonce-1`)).toBe(false)
    })

  it('fails when this browser has no device key', async () => {
    await expect(reauth('unpair', 'target-device')).rejects.toMatchObject({ code: 'DEVICE_KEY_UNAVAILABLE' })
  })
})

describe('companion client', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const spy = () => vi.spyOn(getSharedApiClient(), 'request').mockResolvedValue({} as never) as unknown as { mock: { calls: [string, { method?: string; body?: unknown; queueOnOffline?: boolean }][] } }

  it('setLost does not queue offline', async () => {
    const request = spy()
    const body = { on: true as const, message: 'call me', show_phone: true, show_telegram: false }
    await companion.setLost('dev 1', body)
    expect(request.mock.calls[0]).toEqual(['/api/v1/companion/devices/dev%201/lost-mode', { method: 'PUT', body, queueOnOffline: false }])
  })

  it.each([{ id: 'c-7', delivered: true }, { command_id: 'c-8' }, { id: 'ignored', command_id: 'c-9' }])(
    'command routes normalise %j to command_id', async (reply) => {
      vi.spyOn(getSharedApiClient(), 'request').mockResolvedValue(reply as never)
      const want = (reply as { command_id?: string; id?: string }).command_id ?? (reply as { id?: string }).id
      const calls = [companion.find('d'), companion.addWifi('d', 'b'), companion.scanWifi('d'), companion.removeWifi('d', 'n'),
        companion.orderWifi('d', ['n']), companion.setSettings('d', { brightness: 50 }), companion.restart('d')]
      for (const result of await Promise.all(calls)) expect(result).toEqual({ command_id: want })
    })

  it('maps every call to its route, method and body', async () => {
    const request = spy()
    await companion.requestPairing('hash', 'pub')
    await companion.approve('p1', 's', '123456')
    await companion.list(); await companion.state('d'); await companion.find('d'); await companion.scanWifi('d')
    await companion.addWifi('d', 'blob'); await companion.removeWifi('d', 'Net'); await companion.orderWifi('d', ['a', 'b'])
    await companion.setSettings('d', { brightness: 50 }); await companion.restart('d')
    await companion.unpair('d', { challenge_id: 'c', signature: 's' }); await companion.setIce('d', { contacts: [], med_note: '', show_name: true })
    expect(request.mock.calls.map(([path, o]) => `${o?.method} ${path}`)).toEqual([
      'POST /api/v1/pairing/request', 'POST /api/v1/pairing/p1/approve', 'GET /api/v1/companion/devices', 'GET /api/v1/companion/devices/d',
      'POST /api/v1/companion/devices/d/find', 'POST /api/v1/companion/devices/d/wifi-scan', 'POST /api/v1/companion/devices/d/wifi',
      'POST /api/v1/companion/devices/d/wifi/remove', 'PUT /api/v1/companion/devices/d/wifi/order', 'PUT /api/v1/companion/devices/d/settings',
      'POST /api/v1/companion/devices/d/restart', 'POST /api/v1/companion/devices/d/unpair', 'PUT /api/v1/companion/devices/d/ice',
    ])
    expect(request.mock.calls[0][1]).toMatchObject({ body: { secret_hash: 'hash', public_key: 'pub', platform: 'companion', display_name: 'Aelys' } })
    expect(request.mock.calls[1][1]).toMatchObject({ body: { secret: 's', sas: '123456' } })
    expect(request.mock.calls.every(([, o]) => o?.queueOnOffline === false)).toBe(true)
  })

  it('maps the weather city routes and never queues them offline', async () => {
    const request = spy()
    await companion.weather(); await companion.setWeather({ name: 'Testville', lat: 55.8, lon: 37.6 }); await companion.clearWeather()
    expect(request.mock.calls.map(([path, o]) => `${o?.method} ${path}`)).toEqual(['GET /api/v1/companion/weather', 'PUT /api/v1/companion/weather', 'DELETE /api/v1/companion/weather'])
    expect(request.mock.calls[1][1]).toMatchObject({ body: { name: 'Testville', lat: 55.8, lon: 37.6 } })
    expect(request.mock.calls.every(([, o]) => o?.queueOnOffline === false)).toBe(true)
  })
})
