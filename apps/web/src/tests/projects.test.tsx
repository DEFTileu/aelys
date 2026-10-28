import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectsView } from '../views/ProjectsView'

describe('ProjectsView', () => {
  let root: ReturnType<typeof createRoot> | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  it('keeps project data explicit while offline', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root?.render(<ProjectsView apiStatus="offline" />) })
    expect(host.textContent).toContain('Projects')
    expect(host.textContent).toContain('Projects are offline')
    expect(host.textContent).toContain('New project')
  })
})
