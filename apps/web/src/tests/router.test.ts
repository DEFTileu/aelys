import { describe, expect, it } from 'vitest'
import { getRoute } from '../lib/router'

describe('web routes', () => {
  it.each(['/apps', '/apps/', '/knowledge', '/knowledge/', '/widgets', '/widgets/', '/english', '/english/'])('accepts the reference navigation route %s', (path) => {
    expect(getRoute(path)).toBe(path.replace(/\/$/, ''))
  })
  it('redirects the old /utilities link to /apps', () => { expect(getRoute('/utilities')).toBe('/apps') })
})
