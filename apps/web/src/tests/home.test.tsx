import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeView } from '../views/HomeView'

describe('HomeView', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; window.localStorage.clear() })

  it('renders the design default My day widgets with demo data', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root?.render(<HomeView apiStatus="offline" />) })
    expect(host.textContent).toContain('My day')
    expect(host.textContent).toContain('9 widgets')
    expect(host.textContent).toContain('Team call')
    expect(host.querySelector('[aria-label="Dashboard widgets"]')?.children.length).toBe(9)
  })
})
