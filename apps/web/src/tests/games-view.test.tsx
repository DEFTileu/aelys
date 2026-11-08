import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { GameId } from '../lib/games'
import GamesApp from '../views/GamesApp'

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
async function mount(id: GameId) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<GamesApp id={id} />)) }
const label = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const named = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith(name))!
const status = () => host.querySelector('.game-status')!.textContent
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('plays two-player tic-tac-toe offline, keeps score and starts a new round', async () => {
  const network = vi.fn(); vi.stubGlobal('fetch', network)
  await mount('ttt')
  expect(status()).toBe('X to move')
  for (const cell of [1, 4, 2, 5, 3]) await act(async () => label(`Cell ${cell}`).click()) // X: 1,2,3
  expect(status()).toBe('X wins')
  expect(host.querySelector('.game-score')!.textContent).toBe('X 1O 0')
  await act(async () => named('New round').click())
  expect(status()).toBe('X to move')
  expect(network).not.toHaveBeenCalled()
})

it('alternates connect-four players', async () => {
  await mount('c4')
  expect(status()).toBe('Red to move')
  await act(async () => label('Drop in column 1').click())
  expect(status()).toBe('Yellow to move')
})

it('uses a card frame on desktop and a full-width frame on phones', async () => {
  await mount('2048')
  expect(host.querySelector('.app-panel.games')).not.toBeNull(); expect(host.querySelector('.games--mobile')).toBeNull()
  act(() => root!.unmount()); host.remove()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
  await mount('2048')
  expect(host.querySelector('.games--mobile')).not.toBeNull(); expect(host.querySelector('.app-panel')).toBeNull()
})
