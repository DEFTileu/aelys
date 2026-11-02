import { describe, expect, it } from 'vitest'
import { weatherWallpaperUrl } from '../lib/weatherWallpaper'

const now = new Date('2026-11-01T07:00:00Z')
const f = (code: number, isDay = true, fetchedAt = now.getTime()) => ({ code, isDay, fetchedAt, utcOffsetSeconds: 0 })

describe('weatherWallpaperUrl', () => {
  it.each([[0, 'clear'], [1, 'clear'], [2, 'cloudy'], [3, 'cloudy'], [45, 'rain'], [67, 'rain'], [80, 'rain'], [82, 'rain'], [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow']])('code %s is %s by day', (code, name) => {
    expect(weatherWallpaperUrl(f(code), now)).toBe(`/wallpapers/${name}.jpg`)
  })
  it('is night when is_day is 0, whatever the code', () => expect(weatherWallpaperUrl(f(61, false), now)).toBe('/wallpapers/night.jpg'))
  it('falls back to the clock for stale or missing forecasts', () => {
    expect(weatherWallpaperUrl(null, now)).toBeNull()
    expect(weatherWallpaperUrl(f(61, true, now.getTime() - 2 * 86_400_000), now)).toBeNull()
  })
})
