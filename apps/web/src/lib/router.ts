import type { RoutePath } from '../types'

export function getRoute(pathname = window.location.pathname): RoutePath {
  const clean = pathname.replace(/\/$/, '') || '/'
  const path = clean === '/utilities' ? '/apps' : clean // old links
  const validRoutes: RoutePath[] = ['/', '/projects', '/notes', '/tasks', '/calendar', '/mail', '/finance', '/knowledge', '/widgets', '/timer', '/english', '/ai', '/apps', '/developer', '/automation', '/messages', '/search', '/settings', ...(import.meta.env.DEV ? ['/components' as const] : [])]
  return validRoutes.includes(path as RoutePath) ? (path as RoutePath) : '/'
}

export function navigate(path: RoutePath): void {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
