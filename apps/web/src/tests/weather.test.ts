import { describe, expect, it } from 'vitest'
import { getSolarPeriod, selectWeatherBackground, weatherManifest } from '../data/weather'

describe('weather background selector', () => {
  it('maps local hours to a solar period', () => {
    expect(getSolarPeriod(new Date(2026, 9, 28, 7))).toBe('morning')
    expect(getSolarPeriod(new Date(2026, 9, 28, 13))).toBe('day')
    expect(getSolarPeriod(new Date(2026, 9, 28, 18))).toBe('evening')
    expect(getSolarPeriod(new Date(2026, 9, 28, 23))).toBe('night')
  })

  it('prefers exact weather and falls back within the period', () => {
    expect(selectWeatherBackground('evening', 'rain').id).toBe('evening-rain')
    expect(selectWeatherBackground('morning', 'unknown').id).toBe('morning-sunny')
    expect(selectWeatherBackground('night', 'cloudy').id).toBe('night-clear')
  })

  it('contains exactly the 13 supplied backgrounds', () => {
    expect(weatherManifest).toHaveLength(13)
    expect(new Set(weatherManifest.map((entry) => entry.file)).size).toBe(13)
  })
})
