import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppsView, siteUrl } from '../views/AppsView'

const client = vi.hoisted(() => ({ focusSessions: vi.fn(), automations: vi.fn(), agentSessions: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const nav = vi.hoisted(() => vi.fn())
vi.mock('../lib/router', () => ({ navigate: nav }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
const mount = async () => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<AppsView apiStatus="ready" />)) }
const find = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? [...host.querySelectorAll<HTMLElement>('button')].find(b => b.textContent === label)!
const press = async (label: string) => act(async () => find(label).click())
const type = async (label: string, value: string) => act(async () => { const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear()
  client.focusSessions.mockResolvedValue([{ started_at: new Date().toISOString(), elapsed_seconds: 4500 }])
  client.automations.mockResolvedValue([{ enabled: true }, { enabled: false }]); client.agentSessions.mockResolvedValue([])
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = '' })

it('groups apps as designed and shows real statuses only', async () => {
  await mount()
  const text = host.textContent!
  for (const title of ['Pinned', 'Quick tools', 'Games', 'Learn & create', 'Your sites']) expect(text).toContain(title)
  for (const title of ['Plan & reflect', 'Review', 'Weeks', 'Habits', 'Countdowns', 'Breathe']) expect(text).not.toContain(title)
  expect(text).toContain('1h 15m today'); expect(text).toContain('1 rule on'); expect(text).not.toContain('3 of 5')
  expect(host.querySelectorAll('.apps-soon').length).toBe(4)
})
it('opens real routes, local apps and ignores Soon tiles', async () => {
  await mount()
  await act(async () => [...host.querySelectorAll<HTMLElement>('.apps-card__open')].find(b => b.textContent === 'Automation')!.click())
  expect(nav).toHaveBeenCalledWith('/automation')
  const cards = [...host.querySelectorAll<HTMLButtonElement>('.apps-card__open')].find(b => b.textContent === 'Cards')!
  expect(cards.disabled).toBe(true)
  await act(async () => [...host.querySelectorAll<HTMLElement>('.apps-card__open')].find(b => b.textContent === 'Calculator')!.click())
  await type('Expression', '15% of 80')
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(host.textContent).toContain('= 12')
  await act(async () => host.querySelector<HTMLElement>('.apps-back button')!.click())
  expect(host.querySelector('input[aria-label="Search apps"]')).not.toBeNull()
})
it('pins persist and search filters', async () => {
  await mount()
  await press('Unpin Focus'); expect(JSON.parse(localStorage.getItem('aelys.apps.pins.v1')!)).not.toContain('focus')
  await type('Search apps', 'zzz'); expect(host.textContent).toContain('No apps match')
  await type('Search apps', 'breath'); expect(host.textContent).toContain('No apps match')
  await type('Search apps', 'calculator'); expect(host.textContent).toContain('Results'); expect(host.textContent).toContain('Calculator')
})
it('adds, edits, opens with noopener and removes a site', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  await mount()
  await press('Add site'); await type('Site address', 'bad'); await press('Add'); expect(host.querySelector('[role=alert]')).not.toBeNull()
  await type('Site address', 'https://notion.so/'); await press('Add')
  expect(JSON.parse(localStorage.getItem('aelys.apps.sites.v1')!)[0]).toMatchObject({ t: 'Notion', u: 'notion.so' })
  await act(async () => host.querySelector<HTMLElement>('.apps-site__open')!.click())
  expect(open).toHaveBeenCalledWith('https://notion.so/', '_blank', 'noopener')
  await press('Edit Notion'); await press('Remove'); expect(host.querySelector('.apps-site')).toBeNull()
})
it('only accepts plain https web addresses', () => {
  expect(siteUrl('mysite.com/app')).toBe('https://mysite.com/app'); expect(siteUrl('user:pw@evil.com')).toBeNull(); expect(siteUrl('localhost')).toBeNull()
})

it('lists every game as its own module in a Games category and opens one', async () => {
  await mount()
  const games = host.querySelector('section[aria-label="Games"]')!
  expect([...games.querySelectorAll('.apps-card__open')].map(b => b.textContent)).toEqual(['Air hockey', 'Reaction duel', 'Connect four', 'Tic-tac-toe', 'Snake', '2048', 'Memory'])
  await press('Tic-tac-toe')
  // The game chunk is lazy-loaded, so poll instead of guessing a delay.
  for (let i = 0; i < 100 && !host.querySelector('.game-status'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(host.querySelector('.apps-back strong')!.textContent).toBe('Tic-tac-toe')
  expect(host.querySelector('.game-status')!.textContent).toBe('X to move')
  await press('Apps')
  expect(host.querySelector('section[aria-label="Games"]')).not.toBeNull()
})
