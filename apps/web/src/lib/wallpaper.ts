import { useEffect, useState } from 'react'
import { WALLPAPERS } from '../data/desktop/settings'
import { forecastBackgroundUrl } from '../data/weather'
import { useDesktopState } from './desktopStore'
import { useWeather } from './weather'
import { weatherWallpaperUrl } from './weatherWallpaper'

/** One existing, consent-based weather store drives desktop, phone and cards. */
export function useWallpaper(): string {
  const settings = useDesktopState()
  const { forecast } = useWeather()
  const [, tickClock] = useState(0)
  useEffect(() => {
    const tick = () => tickClock(value => value + 1)
    const timer = window.setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [])
  if (settings.wallpaperMode === 'weather') return weatherWallpaperUrl(forecast) ?? forecastBackgroundUrl(forecast)
  return settings.wallpaper === -1 && settings.customWallpaper ? settings.customWallpaper : WALLPAPERS[settings.wallpaper] ?? WALLPAPERS[0]
}
