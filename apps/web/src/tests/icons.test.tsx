import { createRef } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Calendar, SquareCheck } from '../icons'

describe('Aelys icon accessibility', () => {
  let root: ReturnType<typeof createRoot> | undefined
  afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = '' })

  it('keeps decorative icons out of the accessibility tree and forwards styling/ref', () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    const ref = createRef<SVGSVGElement>()
    act(() => root?.render(<SquareCheck ref={ref} size={16} strokeWidth={2} className="task-status" />))
    const svg = host.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.getAttribute('role')).toBeNull()
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('stroke-width')).toBe('2')
    expect(svg.classList.contains('task-status')).toBe(true)
    expect(ref.current).toBe(svg)
  })

  it('exposes a meaningful label without hiding the image', () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<Calendar title="Calendar" aria-label="Open calendar" />))
    const svg = host.querySelector('svg')!
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-hidden')).toBeNull()
    expect(svg.getAttribute('aria-label')).toBe('Open calendar')
    expect(svg.querySelector('title')?.textContent).toBe('Calendar')
  })
})
