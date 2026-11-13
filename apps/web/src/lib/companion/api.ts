import { getApiConfig, getSharedApiClient, signWithThisDevice } from '../api'
import { loadNativeTransport, isNativeHost, nativeBackendOrigin } from '../nativeTransport'
import type { CommandResult, CompanionDevice, CompanionReauth, CompanionState, IceBody, LostBody } from './types'

export { encryptWifi, newPairingSecret, sha256Hex } from './ecies'

const send = <T>(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown) =>
  getSharedApiClient().request<T>(`/api/v1${path}`, { method, body, queueOnOffline: false })
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
  find: (id: string) => send<CommandResult>(`${dev(id)}/find`, 'POST'),
  addWifi: (id: string, blob: string) => send<CommandResult>(`${dev(id)}/wifi`, 'POST', { blob }),
  scanWifi: (id: string) => send<CommandResult>(`${dev(id)}/wifi-scan`, 'POST'),
  removeWifi: (id: string, ssid: string) => send<CommandResult>(`${dev(id)}/wifi/remove`, 'POST', { ssid }),
  orderWifi: (id: string, ssids: string[]) => send<CommandResult>(`${dev(id)}/wifi/order`, 'PUT', { ssids }),
  setSettings: (id: string, body: { brightness: number }) => send<CommandResult>(`${dev(id)}/settings`, 'PUT', body),
  restart: (id: string) => send<CommandResult>(`${dev(id)}/restart`, 'POST'),
  unpair: (id: string, reauth: CompanionReauth) => send<void>(`${dev(id)}/unpair`, 'POST', { reauth }),
}

/** Fresh challenge for the calling device, signed over the purpose-bound context the backend verifies. */
export async function reauth(purpose: 'lost_off' | 'unpair', targetId: string): Promise<CompanionReauth> {
  if (isNativeHost()) return (await loadNativeTransport()).deviceReauth(nativeBackendOrigin(getApiConfig().baseUrl), purpose, targetId)
  return signWithThisDevice(purpose === 'lost_off' ? 'aelys-companion-lost-off-v1' : 'aelys-companion-unpair-v1', targetId)
}
