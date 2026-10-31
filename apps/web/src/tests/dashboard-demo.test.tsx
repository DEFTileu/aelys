import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeView } from '../views/HomeView'
import * as localBrowserLogin from '../lib/localBrowserLogin'
import { createDashboardDemo } from '../data/desktop/dashboardDemo'
import { formatMoney, sumDecimals } from '../lib/money'
import { WEATHER_STORAGE_KEY } from '../lib/weather'

const client = vi.hoisted(() => ({ tasks: vi.fn(), calendarOccurrences: vi.fn(), projects: vi.fn(), notes: vi.fn(), financeTransactions: vi.fn(), focusSessions: vi.fn(), mailMessages: vi.fn(), activity: vi.fn(), updateTask: vi.fn(), startFocusSession: vi.fn(), stopFocusSession: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks()
  Object.values(client).forEach(method => method.mockResolvedValue([]))
  vi.spyOn(localBrowserLogin, 'localBrowserLaunchId').mockReturnValue('demo-test-launch')
  history.replaceState({}, '', '/?demo=1')
})
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; history.replaceState({}, '', '/'); localStorage.clear(); sessionStorage.clear() })
async function mount() {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<HomeView apiStatus="ready" />))
  return host
}
async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === text)!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}

describe('local dashboard demo', () => {
  it('renders labelled examples with correct totals without loading or persisting real records', async () => {
    const weatherBefore = localStorage.getItem(WEATHER_STORAGE_KEY)
    const host = await mount()
    expect(host.textContent).toContain('Демо-данные')
    expect(host.textContent).toContain('Проверить адаптивность виджетов')
    expect(host.textContent).toContain('Семинар · проектирование систем')
    expect(host.textContent).toContain('Aelys · Personal OS')
    expect(host.textContent).toContain('Идеи для домашнего экрана')
    expect(host.textContent).toContain('161450')
    expect(host.querySelector('[aria-label="Пример погоды"]')).not.toBeNull()
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(6)
    expect(Object.values(client).every(method => method.mock.calls.length === 0)).toBe(true)
    expect(localStorage.getItem(WEATHER_STORAGE_KEY)).toBe(weatherBefore)
    expect(Object.values(localStorage).join('')).not.toContain('demo-task')
  })

  it('keeps task and timer interactions local and restores real data on exit', async () => {
    client.tasks.mockResolvedValue([{ id: 'real-task', title: 'Моя настоящая задача', status: 'todo', due_at: null }])
    const host = await mount()
    const checkbox = host.querySelector<HTMLButtonElement>('[role="checkbox"]')!
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    await act(async () => checkbox.click())
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    vi.useFakeTimers()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Start focus"]')!.click())
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(host.querySelector('.home-focus-time')?.textContent).toBe('12:36')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Finish focus"]')!.click())
    expect(host.querySelector('.home-focus-time')?.textContent).toBe('00:00')
    await click(host, 'Показать мои данные')
    expect(location.search).toBe('')
    expect(host.textContent).toContain('Моя настоящая задача')
    expect(host.textContent).not.toContain('Проверить адаптивность виджетов')
    expect(client.updateTask).not.toHaveBeenCalled()
    expect(client.startFocusSession).not.toHaveBeenCalled()
    expect(client.stopFocusSession).not.toHaveBeenCalled()
  })

  it('can be enabled from the local page and remains explicit after reload', async () => {
    history.replaceState({}, '', '/')
    const host = await mount()
    expect(host.textContent).toContain('No tasks yet.')
    await click(host, 'Показать демо')
    expect(location.search).toBe('?demo=1')
    expect(host.textContent).toContain('Демо-данные')
    await act(async () => root!.unmount()); root = undefined
    const restored = await mount()
    expect(restored.textContent).toContain('Демо-данные')
  })

  it('ignores the demo URL outside local development', async () => {
    vi.mocked(localBrowserLogin.localBrowserLaunchId).mockReturnValue(undefined)
    const host = await mount()
    expect(host.querySelector('[aria-label="Демонстрационные данные"]')).toBeNull()
    expect(host.textContent).not.toContain('Проверить адаптивность виджетов')
    expect(client.tasks).toHaveBeenCalledOnce()
  })

  it('builds independent fixtures with valid dates, project links and decimal amounts', () => {
    const data = createDashboardDemo(new Date('2026-10-31T08:00:00+05:00'))
    const projectIds = new Set(data.projects.map(project => project.id))
    expect(data.tasks.every(task => projectIds.has(task.project_id!))).toBe(true)
    expect(data.events.every(event => Date.parse(event.starts_at) < Date.parse(event.ends_at))).toBe(true)
    expect(data.finance.every(item => typeof item.amount === 'string')).toBe(true)
    expect(formatMoney(sumDecimals(data.finance.map(item => item.amount)))).toBe('161450.00')
    expect(createDashboardDemo().tasks).not.toBe(data.tasks)
  })
})
