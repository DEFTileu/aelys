import { describe, expect, it } from 'vitest'
import { DEFAULT_MOBILE_WIDGETS, readMobileWidgets, saveMobileWidgets } from '../data/mobile'

describe('mobile widgets', () => {
  it('round-trips the layout and drops unknown widgets or sizes', () => {
    saveMobileWidgets([['notes', 'M'], ['today', 'L']])
    expect(readMobileWidgets()).toEqual([['notes', 'M'], ['today', 'L']])

    window.localStorage.setItem('aelys.mobile.widgets.v1', JSON.stringify([['kb', 'M'], ['today', 'S'], ['fin', 'S']]))
    expect(readMobileWidgets()).toEqual([['fin', 'S']])

    window.localStorage.setItem('aelys.mobile.widgets.v1', '{broken')
    expect(readMobileWidgets()).toEqual(DEFAULT_MOBILE_WIDGETS)
  })
})
