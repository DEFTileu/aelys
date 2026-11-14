import { getApiConfig, getSharedApiClient, signWithThisDevice } from '../api'
import { loadNativeTransport, isNativeHost, nativeBackendOrigin } from '../nativeTransport'
import type { CommandResult, CompanionDevice, CompanionReauth, CompanionState, CompanionWeather, IceBody, LostBody } from './types'

export { encryptWifi, newPairingSecret, sha256Hex } from './ecies'

const send = <T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown) =>
  getSharedApiClient().request<T>(`/api/v1${path}`, { method, body, queueOnOffline: false })
/** Plan 2 answers command routes with `{id, delivered}`; the app only ever uses `command_id`. */
const command = async (path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<CommandResult> => {
  const r = await send<{ command_id?: string; id?: string }>(path, method, body)
  return { command_id: (r.command_id ?? r.id)! }
}
const dev = (id: string) => `/companion/devices/${encodeURIComponent(id)}`

export const companion = {
  requestPairing: (secretHash: string, publicKey: string) =>
    send<{ pairing_id: string }>('/pairing/request', 'POST', { secret_hash: secretHash, public_key: publicKey, platform: 'companion', display_name: 'Aelys' }),
  approve: (pairingId: string, secret: string, sas: string) =>
    send<{ device_id: string }>(`/pairing/${encodeURIComponent(pairingId)}/approve`, 'POST', { secret, sas }),
  list: () => send<CompanionDevice[]>('/companion/devices', 'GET'),
  state: (id: string) => send<CompanionState>(dev(id), 'GET'),
  setLost: (id: string, body: LostBody) => send<void>(`${dev(id)}/lost-mode`, 'PUT', body),
  setIce: (id: string, body: IceBody) => send<void>(`${dev(id)}/ice`, 'PUT', body),
  find: (id: string) => command(`${dev(id)}/find`, 'POST'),
  addWifi: (id: string, blob: string) => command(`${dev(id)}/wifi`, 'POST', { blob }),
  scanWifi: (id: string) => command(`${dev(id)}/wifi-scan`, 'POST'),
  removeWifi: (id: string, ssid: string) => command(`${dev(id)}/wifi/remove`, 'POST', { ssid }),
  orderWifi: (id: string, ssids: string[]) => command(`${dev(id)}/wifi/order`, 'PUT', { ssids }),
  setSettings: (id: string, body: { brightness: number }) => command(`${dev(id)}/settings`, 'PUT', body),
  restart: (id: string) => command(`${dev(id)}/restart`, 'POST'),
  /** The owner's weather city for the board (not per device); the server keeps coordinates rounded to 0.1 degree. */
  weather: () => send<CompanionWeather>('/companion/weather', 'GET'),
  setWeather: (body: { name: string; lat: number; lon: number }) => send<CompanionWeather>('/companion/weather', 'PUT', body),
  clearWeather: () => send<CompanionWeather>('/companion/weather', 'DELETE'),
  unpair: (id: string, reauth: CompanionReauth) => send<void>(`${dev(id)}/unpair`, 'POST', { reauth }),
}

/** Fresh challenge for the calling device, signed over the purpose-bound context the backend verifies. */
export async function reauth(purpose: 'lost_off' | 'unpair', targetId: string): Promise<CompanionReauth> {
  if (isNativeHost()) return (await loadNativeTransport()).deviceReauth(nativeBackendOrigin(getApiConfig().baseUrl), purpose, targetId)
  return signWithThisDevice(purpose === 'lost_off' ? 'aelys-companion-lost-off-v1' : 'aelys-companion-unpair-v1', targetId)
}
