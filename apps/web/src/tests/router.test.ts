import { describe, expect, it } from 'vitest'
import { getRoute } from '../lib/router'

describe('web routes', () => {
  it.each(['/utilities', '/utilities/', '/knowledge', '/knowledge/', '/widgets', '/widgets/'])('accepts the reference navigation route %s', (path) => {
    expect(getRoute(path)).toBe(path.replace(/\/$/, ''))
  })
})
