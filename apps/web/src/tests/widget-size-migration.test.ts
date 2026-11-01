import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, DEFAULT_SIZES, HOME_LAYOUT_KEY, LEGACY_HOME_LAYOUT_KEY, LEGACY_MOBILE_HOME_LAYOUT_KEY, MOBILE_HOME_LAYOUT_KEY, OLDER_HOME_LAYOUT_KEY, PREVIOUS_HOME_LAYOUT_KEY, WIDGET_GRID_GAP, WIDGET_GRID_ROW, WIDGET_SIZES, layoutKey, newLayoutEntry, normalizeWidgetSize, readLayout, reorderLayout, saveLayout, sizeByKey, type LayoutEntry } from '../views/desktop/homeLayout'

beforeEach(() => localStorage.clear())

describe('fixed widget sizes', () => {
  it('offers exactly S 1x1, M 2x1, L 2x2 and Tall 1x2 on a 264 / 16 grid', () => {
    expect(WIDGET_GRID_ROW).toBe(264)
    expect(WIDGET_GRID_GAP).toBe(16)
    expect(WIDGET_SIZES.map(({ id, key, span, rows, height }) => [id, key, span, rows, height])).toEqual([['1x1', 'S', 1, 1, 264], ['2x1', 'M', 2, 1, 264], ['2x2', 'L', 2, 2, 544], ['1x2', 'Tall', 1, 2, 544]])
  })
  it('uses the design default layout and sizes', () => {
    expect(DEFAULT_LAYOUT.map(([id, span, height]) => [id, span, height])).toEqual([['today', 1, 264], ['cal', 1, 264], ['focus', 1, 264], ['weather', 1, 264], ['proj', 1, 264], ['notes', 1, 264], ['fin', 1, 264], ['kb', 1, 264]])
  })
  it('snaps every widget to S, M, L or Tall; Recent activity is no longer a widget', () => {
    expect(normalizeWidgetSize(4, 264)).toMatchObject({ key: 'M' })
    expect(normalizeWidgetSize(4, 560)).toMatchObject({ key: 'L' })
    expect(sizeByKey('Tall')).toMatchObject({ span: 1, height: 544 })
  })
  it('snaps legacy freeform dimensions to the nearest of S, M, L and Tall', () => {
    expect(normalizeWidgetSize(1, 176)).toMatchObject({ key: 'S', span: 1, height: 264, rows: 1 })
    expect(normalizeWidgetSize(2, 176)).toMatchObject({ key: 'M', span: 2, height: 264 })
    expect(normalizeWidgetSize(2, 384)).toMatchObject({ key: 'L', span: 2, height: 544, rows: 2 })
    expect(normalizeWidgetSize(4, 560)).toMatchObject({ key: 'L' })
    expect(normalizeWidgetSize(4, 176)).toMatchObject({ key: 'M' })
    expect(normalizeWidgetSize(1, 560)).toMatchObject({ key: 'Tall', span: 1, height: 544 })
    expect(normalizeWidgetSize(3.6, 720).key).toBe('L')
    expect(normalizeWidgetSize(1.2, 176).key).toBe('S')
  })
})

describe('layout migration', () => {
  it('replaces the removed Auto span 0 with that widget default size, keeping order and removals', () => {
    localStorage.setItem(PREVIOUS_HOME_LAYOUT_KEY, JSON.stringify([['focus', 0], ['today', 0], ['notes', 0], ['cal', 0]]))
    const migrated = readLayout()
    expect(migrated.map(([id]) => id)).toEqual(['focus', 'today', 'notes', 'cal'])
    for (const [id, span, height] of migrated) expect([span, height]).toEqual([sizeByKey(DEFAULT_SIZES[id]).span, sizeByKey(DEFAULT_SIZES[id]).height])
    expect(localStorage.getItem(PREVIOUS_HOME_LAYOUT_KEY)).toBe(JSON.stringify([['focus', 0], ['today', 0], ['notes', 0], ['cal', 0]]))
  })
  it('snaps explicit legacy sizes from v2 and v3 and prefers the newest key', () => {
    localStorage.setItem(OLDER_HOME_LAYOUT_KEY, JSON.stringify([['focus', 2, 560], ['today', 1, 368]]))
    expect(readLayout()).toEqual([['focus', 2, 544], ['today', 1, 544]])
    localStorage.setItem(PREVIOUS_HOME_LAYOUT_KEY, JSON.stringify([['cal', 4, 176]]))
    expect(readLayout()).toEqual([['cal', 2, 264]])
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['mail', 1, 264]]))
    expect(readLayout()).toEqual([['mail', 1, 264]])
  })
  it.each([false, true])('migrates v1 while preserving widget order and persisting v4 (mobile=%s)', mobile => {
    const legacyKey = mobile ? LEGACY_MOBILE_HOME_LAYOUT_KEY : LEGACY_HOME_LAYOUT_KEY
    localStorage.setItem(legacyKey, JSON.stringify([['today', 1, 264], ['cal', 2, 264], ['focus', 2, 544], ['activity', 4, 264]]))
    const migrated = readLayout(mobile)
    // A stored Recent activity card is dropped: it is a fixed section now.
    expect(migrated).toEqual([['today', 1, 264], ['cal', 2, 264], ['focus', 2, 544]])
    saveLayout(migrated, mobile)
    localStorage.setItem(legacyKey, '[]')
    expect(readLayout(mobile)).toEqual(migrated)
  })
  it('migrates legacy tuples, removes duplicate legacy ids and rejects unknown or invalid cards', () => {
    localStorage.setItem(LEGACY_HOME_LAYOUT_KEY, JSON.stringify([['today', 10], ['cal', 0, 9999], ['today', 1], ['unknown', 2], ['fin', null], ['focus', 2, 384]]))
    expect(readLayout()).toEqual([['today', 2, 264], ['cal', 1, 264], ['focus', 2, 544]])
  })
  it('keeps desktop and mobile layouts durable and independent', () => {
    const desktop: LayoutEntry[] = [['today', 2, 544]]
    const mobile: LayoutEntry[] = [['mail', 2, 264], ['focus', 1, 264]]
    expect(readLayout(true).map(([id]) => id)).toEqual(['today', 'focus', 'weather', 'cal', 'mail', 'notes', 'fin', 'proj'])
    saveLayout(desktop); saveLayout(mobile, true)
    expect(readLayout()).toEqual(desktop)
    expect(readLayout(true)).toEqual(mobile)
    expect(localStorage.getItem(HOME_LAYOUT_KEY)).not.toEqual(localStorage.getItem(MOBILE_HOME_LAYOUT_KEY))
  })
})

describe('previous default', () => {
  it('treats an untouched copy of the previous desktop default as unset', () => {
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['today', 2, 264], ['focus', 1, 264], ['weather', 1, 264], ['cal', 2, 264], ['proj', 2, 264], ['fin', 2, 264], ['notes', 1, 264], ['mail', 1, 264]]))
    expect(readLayout()).toEqual(DEFAULT_LAYOUT)
    localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify([['today', 2, 264], ['focus', 1, 264]]))
    expect(readLayout()).toEqual([['today', 2, 264], ['focus', 1, 264]])
  })
})

describe('duplicate widgets', () => {
  it('gives a second copy of a widget its own key and keeps both through save and read', () => {
    const first: LayoutEntry = ['cal', 1, 264]
    const second = newLayoutEntry('cal', 'L', [first])
    expect(layoutKey(first)).toBe('cal')
    expect(layoutKey(second)).not.toBe('cal')
    expect(second.slice(0, 3)).toEqual(['cal', 2, 544])
    saveLayout([first, second])
    expect(readLayout()).toEqual([first, second])
    expect(newLayoutEntry('mail', 'M', [first])).toEqual(['mail', 2, 264])
  })
  it('reorders by key, keeping sizes attached to their card', () => {
    const layout: LayoutEntry[] = [['today', 2, 544], ['mail', 2, 264], ['cal', 1, 264], ['cal', 2, 264, 'cal-b']]
    expect(reorderLayout(layout, 'today', 'cal-b').map(layoutKey)).toEqual(['mail', 'cal', 'cal-b', 'today'])
    expect(reorderLayout(layout, 'cal-b', 'today').map(layoutKey)).toEqual(['cal-b', 'today', 'mail', 'cal'])
    expect(layout[0]).toEqual(['today', 2, 544])
  })
})
