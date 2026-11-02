import { useSyncExternalStore } from 'react'
import { isNativeHost } from './nativeTransport'

const MOBILE_QUERY = '(max-width: 700px)'

// Android is the only native host that is always a phone; desktop Tauri is also a native host, so check the platform too.
const nativeAndroid = () => isNativeHost() && /Android/i.test(navigator.userAgent)

function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(MOBILE_QUERY)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => nativeAndroid() || !!window.matchMedia?.(MOBILE_QUERY).matches)
}
