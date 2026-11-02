import { isNativeHost } from './nativeTransport'

export type NotifyPermission = 'granted' | 'denied' | 'prompt' | 'unsupported'

const ASKED_KEY = 'aelys.notifications.asked'

// Only the Tauri apps can raise OS notifications; the plugin is loaded lazily so the browser build never pulls it in.
const plugin = () => import('@tauri-apps/plugin-notification')

export async function notifyPermission(): Promise<NotifyPermission> {
  if (!isNativeHost()) return 'unsupported'
  try { return (await (await plugin()).isPermissionGranted()) ? 'granted' : alreadyAsked() ? 'denied' : 'prompt' } catch { return 'unsupported' }
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!isNativeHost()) return 'unsupported'
  try {
    const result = await (await plugin()).requestPermission()
    try { localStorage.setItem(ASKED_KEY, '1') } catch { /* private mode: the prompt just shows again */ }
    return result === 'granted' ? 'granted' : 'denied'
  } catch { return 'unsupported' }
}

function alreadyAsked() {
  try { return localStorage.getItem(ASKED_KEY) === '1' } catch { return false }
}

/** Asks once, the first time a signed-in native session starts; later changes happen in Settings. */
export async function askNotifyPermissionOnce(): Promise<NotifyPermission> {
  const current = await notifyPermission()
  return current === 'prompt' ? requestNotifyPermission() : current
}

export async function sendSystemNotification(title: string, body?: string | null): Promise<void> {
  if (!isNativeHost()) return
  try {
    const { isPermissionGranted, sendNotification } = await plugin()
    if (await isPermissionGranted()) sendNotification({ title, ...(body ? { body } : {}) })
  } catch { /* a missed OS banner must not break the in-app bell */ }
}
