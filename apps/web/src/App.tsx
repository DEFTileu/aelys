import { useEffect, useState, type ReactElement } from 'react'
import { AppShell } from './components/AppShell'
import { checkApi, getApiConfig } from './lib/api'
import { getRoute } from './lib/router'
import { HomeView } from './views/HomeView'
import { AiView } from './views/AiView'
import { SettingsView } from './views/SettingsView'
import { ModuleView, moduleConfigs } from './views/ModuleView'
import { SearchView } from './views/SearchView'
import { TasksView } from './views/TasksView'
import { ProjectsView } from './views/ProjectsView'
import type { ApiStatus, RoutePath } from './types'

function useRoute(): RoutePath {
  const [route, setRoute] = useState<RoutePath>(() => getRoute())
  useEffect(() => { const onPopState = () => setRoute(getRoute()); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState) }, [])
  return route
}

function useTheme(): ['light' | 'dark', () => void] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (window.localStorage.getItem('aelys.theme') as 'light' | 'dark') || 'light')
  useEffect(() => { document.documentElement.dataset.theme = theme; window.localStorage.setItem('aelys.theme', theme) }, [theme])
  return [theme, () => setTheme((value) => value === 'light' ? 'dark' : 'light')]
}

function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>(() => navigator.onLine ? 'loading' : 'offline')
  useEffect(() => {
    let active = true
    const check = async () => {
      if (!navigator.onLine) { setStatus('offline'); return }
      setStatus('loading')
      try { await checkApi(getApiConfig()); if (active) setStatus('ready') } catch { if (active) setStatus(navigator.onLine ? 'error' : 'offline') }
    }
    const online = () => { void check() }
    const offline = () => setStatus('offline')
    window.addEventListener('online', online); window.addEventListener('offline', offline); void check()
    return () => { active = false; window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [])
  return status
}

export default function App() {
  const route = useRoute()
  const apiStatus = useApiStatus()
  const [theme, toggleTheme] = useTheme()
  const moduleKey = route.slice(1)
  const screens: Partial<Record<RoutePath, ReactElement>> = { '/': <HomeView apiStatus={apiStatus} />, '/ai': <AiView apiStatus={apiStatus} />, '/tasks': <TasksView apiStatus={apiStatus} />, '/projects': <ProjectsView apiStatus={apiStatus} />, '/search': <SearchView apiStatus={apiStatus} />, '/settings': <SettingsView apiStatus={apiStatus} theme={theme} onToggleTheme={toggleTheme} /> }
  const content = screens[route] ?? <ModuleView config={moduleConfigs[moduleKey] ?? moduleConfigs.projects} apiStatus={apiStatus} />
  return <AppShell route={route} apiStatus={apiStatus} theme={theme} onToggleTheme={toggleTheme}>{content}</AppShell>
}
