import { isNativeHost } from './nativeTransport'

/** A dev-server generation marker, never a credential or permission grant. */
export function localBrowserLaunchId(): string | undefined {
  if (!import.meta.env.DEV || isNativeHost()) return undefined
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname)) return undefined
  return import.meta.env.VITE_LOCAL_LAUNCH_ID || undefined
}
