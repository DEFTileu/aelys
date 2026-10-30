import { useTheme } from './lib/theme'
import { Component, lazy, Suspense, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { getApiConfig } from './lib/api'
import { createApiHealth } from './lib/apiHealth'
import { getRoute } from './lib/router'
// React.lazy defers each named view export until AuthGate renders the selected route.
const MobileCustomizeView = lazy(() => import('./views/MobileCustomizeView').then(module => ({ default: module.MobileCustomizeView })))
const HomeView = lazy(() => import('./views/HomeView').then((module) => ({ default: module.HomeView })))
const ComponentsView = lazy(() => import('./views/ComponentsView').then((module) => ({ default: module.ComponentsView })))
const AiView = lazy(() => import('./views/AiView').then((module) => ({ default: module.AiView })))
const MailView = lazy(() => import('./views/MailView').then((module) => ({ default: module.MailView })))
const SettingsView = lazy(() => import('./views/SettingsView').then((module) => ({ default: module.SettingsView })))
const SearchView = lazy(() => import('./views/SearchView').then((module) => ({ default: module.SearchView })))
const TasksView = lazy(() => import('./views/TasksView').then((module) => ({ default: module.TasksView })))
const ProjectsView = lazy(() => import('./views/ProjectsView').then((module) => ({ default: module.ProjectsView })))
const CalendarView = lazy(() => import('./views/CalendarView').then((module) => ({ default: module.CalendarView })))
const KnowledgeView = lazy(() => import('./views/KnowledgeView').then((module) => ({ default: module.KnowledgeView })))
const NotesView = lazy(() => import('./views/NotesView').then((module) => ({ default: module.NotesView })))
const FinanceView = lazy(() => import('./views/FinanceView').then((module) => ({ default: module.FinanceView })))
const TimerView = lazy(() => import('./views/TimerView').then((module) => ({ default: module.TimerView })))
const ModuleView = lazy(() => import('./views/ModuleView').then(({ ModuleView: View, moduleConfigs }) => ({
  default: ({ moduleKey, apiStatus }: { moduleKey: string; apiStatus: ApiStatus }) => <View config={moduleConfigs[moduleKey] ?? moduleConfigs.projects} apiStatus={apiStatus} />,
})))
import type { ApiStatus, RoutePath } from './types'

// A failed chunk must not take down navigation or the authenticated shell. A route
// change resets this boundary, including when the browser caches a failed import.
class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div role="alert">Не удалось загрузить раздел. Проверьте соединение и выберите другой раздел в меню.</div>
    return this.props.children
  }
}

function useRoute(): RoutePath {
  const [route, setRoute] = useState<RoutePath>(() => getRoute())
  useEffect(() => { const onPopState = () => setRoute(getRoute()); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState) }, [])
  return route
}

function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>(() => navigator.onLine ? 'loading' : 'offline')
  useEffect(() => {
    const health = createApiHealth({ getConfig: getApiConfig, isOnline: () => navigator.onLine, publish: setStatus })
    const online = () => { void health.refresh('force') }
    const focus = () => { void health.refresh('focus') }
    const offline = () => health.offline()
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    window.addEventListener('focus', focus); window.addEventListener('aelys:check-api', online)
    void health.refresh('force')
    return () => { health.dispose(); window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('focus', focus); window.removeEventListener('aelys:check-api', online) }
  }, [])
  return status
}

export default function App() {
  const route = useRoute()
  const [theme, toggleTheme] = useTheme()
  // The gallery contains only isolated examples. It never mounts owner/session
  // or health clients and cannot reveal protected workspace data.
  if (route === '/components') return <RouteErrorBoundary key={route}><Suspense fallback={<div role="status">Загрузка компонентов…</div>}><ComponentsView theme={theme} onToggleTheme={toggleTheme} /></Suspense></RouteErrorBoundary>
  return <WorkspaceApp route={route} theme={theme} toggleTheme={toggleTheme} />
}

function WorkspaceApp({ route, theme, toggleTheme }: { route: RoutePath; theme: 'light' | 'dark'; toggleTheme: () => void }) {
  const apiStatus = useApiStatus()
  const moduleKey = route.slice(1)
  const screens: Partial<Record<RoutePath, ReactElement>> = { '/': <HomeView apiStatus={apiStatus} />, '/mail': <MailView apiStatus={apiStatus} />, '/ai': <AiView apiStatus={apiStatus} />, '/tasks': <TasksView apiStatus={apiStatus} />, '/calendar': <CalendarView apiStatus={apiStatus} />, '/projects': <ProjectsView apiStatus={apiStatus} />, '/notes': <NotesView apiStatus={apiStatus} />, '/knowledge': <KnowledgeView apiStatus={apiStatus} />, '/widgets': <MobileCustomizeView theme={theme} onToggleTheme={toggleTheme} />, '/finance': <FinanceView apiStatus={apiStatus} />, '/timer': <TimerView apiStatus={apiStatus} />, '/search': <SearchView apiStatus={apiStatus} />, '/settings': <SettingsView apiStatus={apiStatus} theme={theme} onToggleTheme={toggleTheme} /> }
  const content = screens[route] ?? <ModuleView moduleKey={moduleKey} apiStatus={apiStatus} />
  return <AuthGate apiStatus={apiStatus}><AppShell route={route} apiStatus={apiStatus} theme={theme} onToggleTheme={toggleTheme}><RouteErrorBoundary key={route}><Suspense fallback={<div role="status">Загрузка раздела…</div>}>{content}</Suspense></RouteErrorBoundary></AppShell></AuthGate>
}
