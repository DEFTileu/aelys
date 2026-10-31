import { describe, expect, it } from 'vitest'
import { dayLabel } from '../lib/format'

describe('dayLabel', () => {
  const now = new Date(2026, 9, 28, 12, 0)

  it('names today, tomorrow and yesterday relative to the local day', () => {
    expect(dayLabel(new Date(2026, 9, 28, 23, 59).toISOString(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 29, 0, 1).toISOString(), now)).toBe('Tomorrow')
    expect(dayLabel(new Date(2026, 9, 27, 8, 0).toISOString(), now)).toBe('Yesterday')
  })

  it('falls back to a short date for other days', () => {
    expect(dayLabel(new Date(2026, 10, 3, 9, 0).toISOString(), now)).toBe('Nov 3')
  })
})
