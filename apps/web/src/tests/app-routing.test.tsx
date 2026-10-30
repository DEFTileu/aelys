import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { navigate } from '../lib/router'

const controls = vi.hoisted(() => {
  let resolveTasks!: () => void
  const tasksReady = new Promise<void>((resolve) => { resolveTasks = resolve })
  return { authenticated: false, tasksReady, resolveTasks, tasksLoaded: vi.fn(), shellMounted: vi.fn() }
})

vi.mock('../lib/api', () => ({ checkApi: vi.fn().mockRejectedValue(new Error('bad configuration')), getApiConfig: () => ({ baseUrl: 'invalid' }) }))
vi.mock('../components/AuthGate', () => ({ AuthGate: ({ children }: { children: ReactNode }) => controls.authenticated ? children : <div>Sign in</div> }))
vi.mock('../components/AppShell', async () => {
  const { useEffect } = await import('react')
  return { AppShell: ({ children, route }: { children: ReactNode; route: string }) => {
    useEffect(() => { controls.shellMounted() }, [])
    return <div data-testid="shell"><span>Shell: {route}</span>{children}</div>
  } }
})
vi.mock('../views/TasksView', async () => {
  controls.tasksLoaded()
  await controls.tasksReady
  return { TasksView: ({ apiStatus }: { apiStatus: string }) => <div>Tasks: {apiStatus}</div> }
})
vi.mock('../views/FinanceView', () => { throw new Error('chunk unavailable') })
vi.mock('../views/SettingsView', () => ({ SettingsView: ({ apiStatus, theme, onToggleTheme }: { apiStatus: string; theme: string; onToggleTheme: () => void }) => <button onClick={onToggleTheme}>Settings: {apiStatus} {theme}</button> }))

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

it('defers protected routes, keeps the shell through loading and recovers from a failed chunk', async () => {
  history.replaceState({}, '', '/tasks')
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<App />) })
  expect(host.textContent).toContain('Sign in')
  expect(controls.tasksLoaded).not.toHaveBeenCalled()
  expect(host.querySelector('[data-testid="shell"]')).toBeNull()

  controls.authenticated = true
  await act(async () => { root!.render(<App />) })
  const shell = host.querySelector('[data-testid="shell"]')
  expect(shell).not.toBeNull()
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Загрузка')
  expect(controls.tasksLoaded).toHaveBeenCalledTimes(1)
  await act(async () => { controls.resolveTasks(); await controls.tasksReady })
  expect(host.textContent).toContain('Tasks: error')

  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { navigate('/finance') })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Не удалось загрузить раздел')
  expect(host.querySelector('[data-testid="shell"]')).toBe(shell)
  errorLog.mockRestore()

  await act(async () => { navigate('/settings') })
  expect(host.textContent).toContain('Settings: error light')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  await act(async () => { host.querySelector('button')!.click() })
  expect(host.textContent).toContain('Settings: error dark')
  expect(host.querySelector('[data-testid="shell"]')).toBe(shell)
  expect(controls.shellMounted).toHaveBeenCalledTimes(1)
})
