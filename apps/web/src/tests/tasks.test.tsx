import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TasksView } from '../views/TasksView'

describe('TasksView', () => {
  let root: ReturnType<typeof createRoot> | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  it('keeps the task workspace explicit while offline', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root?.render(<TasksView apiStatus="offline" />) })
    expect(host.textContent).toContain('My tasks')
    expect(host.textContent).toContain('Tasks are offline')
    expect(host.textContent).toContain('Filters')
  })
})
