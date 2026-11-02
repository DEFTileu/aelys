import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageSkeleton, skeletonLayout } from '../components/PageSkeleton'

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.useRealTimers() })
const mount = (node: React.ReactElement) => { const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(node)); return host }

describe('PageSkeleton', () => {
  it('matches the design card counts and column templates', () => {
    expect(skeletonLayout('home', false).cards).toHaveLength(6)
    expect(skeletonLayout('home', true).cols).toBe('repeat(2,minmax(0,1fr))')
    expect(skeletonLayout('split', false).cols).toBe('320px minmax(0,1fr)')
    expect(skeletonLayout('grid', false).cards).toHaveLength(6)
    expect(skeletonLayout('calendar', false).cols).toBe('minmax(0,1fr) 300px')
    expect(skeletonLayout('settings', false).cards[0].rows).toHaveLength(9)
    expect(skeletonLayout('list', true).cards[0].rows).toHaveLength(7)
  })
  it('shows the slow notice after 2.5 seconds, hidden for the first 200ms and retries', () => {
    vi.useFakeTimers(); const retry = vi.fn()
    const host = mount(<PageSkeleton kind="list" label="Tasks" onRetry={retry} />)
    expect(host.textContent).toContain('Loading Tasks…'); expect(host.textContent).not.toContain('Taking longer than usual'); expect(host.querySelector('.pskel__grid')).toBeNull()
    act(() => { vi.advanceTimersByTime(200) }); expect(host.querySelector('.pskel__grid')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(2500) })
    expect(host.textContent).toContain('Taking longer than usual')
    act(() => host.querySelector<HTMLButtonElement>('.pskel__slow button')!.click()); expect(retry).toHaveBeenCalledTimes(1)
  })
  it('shows the error card with Retry and no skeleton cards', () => {
    const retry = vi.fn(); const host = mount(<PageSkeleton kind="grid" phase="error" label="Projects" onRetry={retry} />)
    expect(host.textContent).toContain('Can’t reach Aelys'); expect(host.querySelector('.pskel__grid')).toBeNull()
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click()); expect(retry).toHaveBeenCalled()
  })
})
