import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeView } from '../views/HomeView'

describe('HomeView', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; window.localStorage.clear() })

  it('renders the supplied local photo hero and honest offline widgets', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root?.render(<HomeView apiStatus="offline" />) })
    expect(host.textContent).toContain('Photo backdrop follows your local solar period')
    expect(host.textContent).toContain('Working offline')
    expect(host.querySelector('.hero')?.getAttribute('style')).toContain('/backgrounds/weather/')
  })
})
