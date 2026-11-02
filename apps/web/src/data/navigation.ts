import type { RoutePath } from '../types'

/** Developer Hub drives local agent sessions, which only exist on the Mac runtime. */
export const isMacPlatform = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
