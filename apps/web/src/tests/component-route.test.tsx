import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { navigate } from '../lib/router'
const calls = vi.hoisted(() => ({ health: vi.fn(), gate: vi.fn() }))
vi.mock('../lib/apiHealth', () => ({ createApiHealth: () => { calls.health(); return { refresh: async () => {}, dispose: () => {} } } }))
vi.mock('../components/AuthGate', () => ({ AuthGate: ({ children }: { children: ReactNode }) => { calls.gate(); return children } }))
vi.mock('../views/ComponentsView', () => ({ ComponentsView: () => <h1>Компоненты</h1> }))
vi.mock('../components/AppShell', () => ({ AppShell: () => <h1>Workspace</h1> }))
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; history.replaceState({}, '', '/'); localStorage.clear() })
it('isolates component examples from backend health and authentication while keeping workspace protected', async () => {
  history.replaceState({}, '', '/components')
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(<App />) })
  expect(host.textContent).toBe('Компоненты')
  expect(calls.health).not.toHaveBeenCalled()
  expect(calls.gate).not.toHaveBeenCalled()
  await act(async () => { navigate('/') })
  expect(calls.health).toHaveBeenCalledTimes(1)
  expect(calls.gate).toHaveBeenCalled()
})
