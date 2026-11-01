import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LaunchIntro } from '../components/LaunchIntro'

const wallpaper = vi.hoisted(() => ({ url: '/backgrounds/originals/glittering-city-beneath-snowy-peaks.png' }))
vi.mock('../lib/wallpaper', () => ({ useWallpaper: () => wallpaper.url }))
let root: ReturnType<typeof createRoot> | undefined

afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.useRealTimers() })

it('updates the launch and sign-in scenery without replaying the intro or losing entered credentials', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const render = () => root!.render(<LaunchIntro resolved locked><input aria-label="Username" defaultValue="1" /></LaunchIntro>)
  await act(async () => render())
  expect(host.querySelector('.launch-intro')?.classList.contains('launch-intro--intro')).toBe(true)
  expect(host.querySelector<HTMLElement>('.launch-intro__scenery')!.style.backgroundImage).toContain('glittering-city-beneath-snowy-peaks.png')
  await act(async () => vi.advanceTimersByTime(2700))
  const field = host.querySelector<HTMLInputElement>('input')!
  expect(field.closest('[inert]')).toBeNull()
  const scenery = host.querySelector('.launch-intro__scenery')
  wallpaper.url = '/backgrounds/originals/rainy-boulevard-beneath-misty-mountains.png'
  await act(async () => render())
  expect(host.querySelector('.launch-intro__scenery')).toBe(scenery)
  expect((scenery as HTMLElement).style.backgroundImage).toContain('rainy-boulevard-beneath-misty-mountains.png')
  expect(host.querySelector('.launch-intro')?.classList.contains('launch-intro--lock')).toBe(true)
  expect(host.querySelector('input')).toBe(field)
  expect(field.value).toBe('1')
  await act(async () => vi.advanceTimersByTime(1150))
  expect(host.querySelector('.launch-stage__card-inner')?.hasAttribute('data-settled')).toBe(true)
})
