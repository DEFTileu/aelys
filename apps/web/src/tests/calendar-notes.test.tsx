import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CalendarView } from '../views/CalendarView'
import { NotesView } from '../views/NotesView'

describe('live calendar and notes views', () => {
  let roots: ReturnType<typeof createRoot>[] = []
  afterEach(() => { act(() => roots.forEach((root) => root.unmount())); roots = []; document.body.innerHTML = '' })

  it('keeps Calendar honest while offline', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host); roots.push(root)
    await act(async () => { root.render(<CalendarView apiStatus="offline" />) })
    expect(host.textContent).toContain('Calendar is offline')
    expect(host.textContent).toContain('Create event')
  })

  it('keeps Notes honest while offline', async () => {
    const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host); roots.push(root)
    await act(async () => { root.render(<NotesView apiStatus="offline" />) })
    expect(host.textContent).toContain('Notes are offline')
    expect(host.textContent).toContain('New note')
  })
})
