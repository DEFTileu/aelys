import type { RoutePath } from '../types'

export function getRoute(pathname = window.location.pathname): RoutePath {
  const path = pathname.replace(/\/$/, '') || '/'
  const validRoutes: RoutePath[] = ['/', '/projects', '/notes', '/tasks', '/calendar', '/mail', '/finance', '/knowledge', '/widgets', '/timer', '/ai', '/developer', '/automation', '/search', '/settings']
  return validRoutes.includes(path as RoutePath) ? (path as RoutePath) : '/'
}

export function navigate(path: RoutePath): void {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
