import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppsView } from '../views/AppsView'

const client = vi.hoisted(() => ({ focusSessions: vi.fn(), automations: vi.fn(), agentSessions: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const nav = vi.hoisted(() => vi.fn())
vi.mock('../lib/router', () => ({ navigate: nav }))

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
const mount = async () => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<AppsView apiStatus="ready" />)) }
const tileButton = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('.apps-m__open')].find(b => b.textContent === title)!
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? [...host.querySelectorAll<HTMLElement>('button')].find(b => b.textContent === label)!

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear()
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query === '(max-width: 700px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia
  client.focusSessions.mockResolvedValue([])
  client.automations.mockResolvedValue([])
  client.agentSessions.mockResolvedValue([])
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; delete (window as { matchMedia?: unknown }).matchMedia })

it('renders grouped tiles on phones and no desktop grid', async () => {
  await mount()
  expect(host.querySelector('.apps.apps-m')).not.toBeNull()
  expect(host.querySelector('.apps:not(.apps-m)')).toBeNull()
  expect(host.querySelector('.apps-m__grid')).not.toBeNull()
  expect(host.querySelector('.apps-card')).toBeNull()
  expect(host.querySelectorAll('.apps-soon').length).toBe(8)
})

it('opens real routes and local apps like desktop, and ignores Soon tiles', async () => {
  await mount()
  expect(tileButton('Habits').disabled).toBe(true)
  await act(async () => tileButton('Automation').click())
  expect(nav).toHaveBeenCalledWith('/automation')
  await act(async () => tileButton('Calculator').click())
  expect(host.querySelector('.apps-back')).not.toBeNull()
  await act(async () => host.querySelector<HTMLElement>('.apps-back button')!.click())
  expect(host.querySelector('input[aria-label="Search apps"]')).not.toBeNull()
})

it('adds a site through a bottom sheet', async () => {
  await mount()
  await act(async () => byLabel('Add site').click())
  expect(host.querySelector('.apps-m__sheet[role="dialog"]')).not.toBeNull()
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Site address"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'notion.so')
  await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => byLabel('Add').click())
  expect(host.querySelector('.apps-m__sheet')).toBeNull()
  expect(JSON.parse(localStorage.getItem('aelys.apps.sites.v1')!)[0]).toMatchObject({ t: 'Notion', u: 'notion.so' })
})
