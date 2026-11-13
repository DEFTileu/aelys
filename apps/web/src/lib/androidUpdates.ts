import { useSyncExternalStore } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { isNativeHost } from './nativeTransport'

type Update = { version: string; size_bytes: number }
type CheckResult = { supported: boolean; current_version: string; update: Update | null }
type Progress = { downloaded: number; total: number }
type State = {
  supported: boolean
  currentVersion: string | null
  update: Update | null
  busy: 'checking' | 'downloading' | 'installing' | null
  progress: Progress | null
  error: string | null
  installerOpened: boolean
  dismissed: boolean
  checked: boolean
}

let state: State = { supported: true, currentVersion: null, update: null, busy: null, progress: null, error: null, installerOpened: false, dismissed: false, checked: false }
let started = false
let downloaded = false
const listeners = new Set<() => void>()
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const snapshot = () => state
export function isAndroidUpdateHost(): boolean { return isNativeHost() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) }
export function useAndroidUpdates(): State { return useSyncExternalStore(subscribe, snapshot, snapshot) }

export async function checkAndroidUpdates(manual = false): Promise<void> {
  if (!isAndroidUpdateHost() || state.busy) return
  if (!manual && started) return
  started = true
  downloaded = false
  publish({ busy: 'checking', error: null, installerOpened: false, update: null, checked: false })
  try {
    const result = await invoke<CheckResult>('android_update_check')
    publish({ supported: result.supported, currentVersion: result.current_version, update: result.update, busy: null, checked: true })
  } catch (error) {
    const code = error instanceof Error ? error.message : error
    publish({ busy: null, error: manual ? code === 'UPDATE_CHANNEL_UNAVAILABLE' ? 'Update channel is not available yet. Please try again later.' : 'Could not check for updates. Please try again.' : null })
  }
}

export async function installAndroidUpdate(): Promise<void> {
  if (!isAndroidUpdateHost() || !state.supported || !state.update || state.busy) return
  publish({ busy: downloaded ? 'installing' : 'downloading', error: null, installerOpened: false, progress: null })
  try {
    if (!downloaded) {
      const onProgress = new Channel<Progress>(progress => publish({ progress }))
      await invoke('android_update_download', { onProgress })
      downloaded = true
      publish({ busy: 'installing' })
    }
    await invoke<'installer_opened'>('android_update_install')
    publish({ busy: null, installerOpened: true })
  } catch (error) {
    const code = error instanceof Error ? error.message : error
    if (code === 'UPDATE_INTEGRITY_FAILED' || code === 'UPDATE_NOT_DOWNLOADED') downloaded = false
    publish({ busy: null, error: code === 'UPDATE_PERMISSION_REQUIRED' ? 'Installation permission is required. Allow it in Android settings, then retry.' : 'Could not update Aelys. Please try again.' })
  }
}

export function dismissAndroidUpdateNotice(): void { publish({ dismissed: true }) }
