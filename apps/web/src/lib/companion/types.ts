// Response/request shapes of the companion routes (backend plan 2 Task 8 + plan 3 Task B1), snake_case as the API returns them.

export interface CompanionReauth { challenge_id: string; signature: string }

export interface LostMode {
  on: boolean
  message: string
  show_phone: boolean
  show_telegram: boolean
  show_email?: boolean
  email?: string | null
  qr?: 'telegram' | 'phone' | 'none'
  /** Server-set. */
  since?: string
}

export interface IceContact { name: string; relation?: string; phone: string }

export interface Ice {
  owner_name?: string
  contacts: IceContact[]
  med_note: string
  show_name: boolean
  show_contacts?: boolean
  show_med?: boolean
}

export interface CompanionDevice {
  device_id: string
  display_name: string
  online: boolean
  last_seen_at: string | null
  wifi_current: string | null
  battery_pct: number | null
}

export interface CompanionMetrics {
  heap_min_internal?: number
  largest_block?: number
  psram_free?: number
  wifi_reconnects?: number
  uptime_s?: number
  battery_pct?: number
  charging?: boolean
  heap_at_connect_min?: number
}

export interface WifiScanNetwork { ssid: string; rssi: number; secure: boolean }

export interface CompanionCommandLogEntry {
  id: string
  name: string
  sent_at: string
  /** null until the board acks. */
  ok: boolean | null
  error_code: string | null
}

export interface CharacterObservation { mood: string; reason: string; reported_at: string }
export interface CompanionCharacter { current: CharacterObservation; recent: CharacterObservation | null }

export interface CompanionState {
  device_id: string
  display_name: string
  online: boolean
  last_seen_at: string | null
  fw_version: string | null
  /** Base64url uncompressed P-256 point; Wi-Fi is encrypted to it. */
  public_key: string
  lost_mode: LostMode | null
  ice: Ice | null
  last_metrics: CompanionMetrics | null
  /** Absent on older servers. */
  character?: CompanionCharacter | null
  last_wifi_scan: { networks: WifiScanNetwork[] } | null
  contacts: { phone?: string; telegram?: string } | null
  wifi: { saved: string[]; current: string | null } | null
  battery: { pct: number; charging: boolean } | null
  settings: { brightness: number } | null
  command_log: CompanionCommandLogEntry[]
}

type LostFields = Omit<LostMode, 'since' | 'on'>
/** Turning lost mode off needs a fresh re-auth proof; turning it on does not. */
export type LostBody = (LostFields & { on: true; reauth?: undefined }) | (LostFields & { on: false; reauth: CompanionReauth })
export type IceBody = Ice
export interface CommandResult { command_id: string }

/** `name` is null while weather is off; `updated` stays null until the server has fetched a first forecast. */
export interface CompanionWeather { name: string | null; lat: number | null; lon: number | null; updated: string | null }
