import { describe, expect, it } from 'vitest'
import { normalizeApiBaseUrl } from '../lib/api'

describe('API boundary configuration', () => {
  it('normalizes a configured base URL without trailing slash', () => {
    expect(normalizeApiBaseUrl(' https://example.test/api/v1/ ')).toBe('https://example.test/api/v1')
  })

  it('uses the documented local default for blank values', () => {
    expect(normalizeApiBaseUrl('')).toBe('/api/v1')
  })
})
