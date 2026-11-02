import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflineGate } from '../components/OfflineGate'
import type { ApiStatus } from '../types'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const render = async (status: ApiStatus) => act(async () => root.render(<OfflineGate route="/tasks" apiStatus={status} compact={false}><p>Screen</p></OfflineGate>))
const setup = () => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) }
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = '' })

describe('OfflineGate', () => {
  it('shows the Can’t reach Aelys card with Retry when offline and nothing loaded', async () => {
    setup(); await render('offline')
    expect(host.textContent).toContain('Can’t reach Aelys'); expect(host.textContent).not.toContain('Screen')
    const check = vi.fn(); window.addEventListener('aelys:check-api', check)
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click())
    expect(check).toHaveBeenCalled(); window.removeEventListener('aelys:check-api', check)
  })
  it('keeps the screen and shows one quiet toast when offline after data loaded', async () => {
    setup(); await render('ready'); await render('offline')
    expect(host.textContent).toContain('Screen'); expect(host.querySelector('.offline-toast')?.textContent).toBe('Offline · changes will sync')
    expect(host.textContent).not.toContain('Can’t reach Aelys')
  })
})
