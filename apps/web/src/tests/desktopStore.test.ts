import { describe, expect, it, vi } from 'vitest'
import { getDesktopState, subscribeDesktop, toggleTask } from '../lib/desktopStore'

describe('desktopStore', () => {
  it('toggling a task persists it and notifies subscribers', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeDesktop(listener)
    const before = getDesktopState().done[2]

    toggleTask(2)
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getDesktopState().done[2]).toBe(!before)
    // A fresh module load reads the saved state back from localStorage.
    vi.resetModules()
    const reloaded = await import('../lib/desktopStore')
    expect(reloaded.getDesktopState().done[2]).toBe(!before)
  })
})
