import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Upload } from '../../icons'
import { accentColors, homeToggles, sliderSettings, VISIBLE_WALLPAPERS, WALLPAPERS } from '../../data/desktop/settings'
import { setHomeToggle, setSettings, useDesktopState } from '../../lib/desktopStore'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { setThemePreference, useThemePreference, type ThemePreference } from '../../lib/theme'
import { Card, Group, Row, SwitchRow } from './ui'

// Mini window previews, with the design's colors for the page, sidebar and cards.
const THEMES: readonly { id: ThemePreference; title: string; bg: string; side: string; card: string }[] = [
  { id: 'light', title: 'Light', bg: '#F5F0EB', side: '#FAF7F4', card: '#fff' },
  { id: 'dark', title: 'Dark', bg: '#141219', side: '#1A1720', card: '#2A2733' },
  { id: 'system', title: 'System', bg: 'linear-gradient(90deg,#F5F0EB 50%,#141219 50%)', side: 'linear-gradient(90deg,#FAF7F4 50%,#1A1720 50%)', card: 'linear-gradient(90deg,#fff 50%,#2A2733 50%)' },
]

export function AppearancePanel() {
  const theme = useThemePreference()
  const { glass, reduceMotion } = usePrefs()
  const { accent, wallpaper, customWallpaper, transparency, blur, homeToggles: toggles } = useDesktopState()
  const [allWallpapers, setAllWallpapers] = useState(false)
  const upload = useRef<HTMLInputElement>(null)
  const sliderValues = [transparency, blur]
  const current = wallpaper === -1 && customWallpaper ? customWallpaper : WALLPAPERS[wallpaper] ?? WALLPAPERS[0]

  function uploadWallpaper(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.addEventListener('load', () => { if (typeof reader.result === 'string') setSettings({ wallpaper: -1, customWallpaper: reader.result }) }, { once: true })
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  return <>
    <Group title="Theme">
      <div className="st-themes" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className="st-theme" onClick={() => setThemePreference(t.id)}>
          <div className="st-theme-art" style={{ '--th-bg': t.bg, '--th-side': t.side, '--th-card': t.card } as CSSProperties}>
            <span className="st-th-side" />
            <span className="st-th-main"><span className="st-th-bar" /><span className="st-th-cards"><span className="st-th-card" /><span className="st-th-card" /></span></span>
          </div>
          <div className="st-theme-foot"><b>{t.title}</b><span className="st-theme-radio" aria-hidden="true" /></div>
        </button>)}
      </div>
    </Group>

    <Card>
      <Row title="Accent color" hint="Buttons, selection and focus" wrap>
        <div className="st-swatches" role="radiogroup" aria-label="Accent color">
          {accentColors.map((a, i) => <button key={a.name} type="button" role="radio" aria-checked={accent === i} aria-label={a.name} className="st-swatch" style={{ '--sw': a.color } as CSSProperties} onClick={() => setSettings({ accent: i })} />)}
        </div>
      </Row>
      <div className="st-row st-row--14">
        <span className="st-photo" aria-hidden="true" style={{ backgroundImage: `url('${current}')` }} />
        <div className="st-grow"><div className="st-label">Background photo</div><div className="st-hint">Pick one below or use your own image</div></div>
        <input ref={upload} className="st-file" type="file" accept="image/*" aria-label="Upload photo" onChange={uploadWallpaper} />
        <button type="button" className="st-btn st-btn--ghost" onClick={() => upload.current?.click()}><Upload size={14} aria-hidden="true" />Upload photo</button>
      </div>
      <div className="st-wallpapers" role="radiogroup" aria-label="Wallpapers">
        {customWallpaper && <button type="button" role="radio" aria-checked={wallpaper === -1} aria-label="Uploaded wallpaper" className="st-wall" style={{ backgroundImage: `url('${customWallpaper}')` }} onClick={() => setSettings({ wallpaper: -1 })}>Uploaded</button>}
        {(allWallpapers ? WALLPAPERS : WALLPAPERS.slice(0, VISIBLE_WALLPAPERS)).map((url, i) => <button key={url} type="button" role="radio" aria-checked={wallpaper === i} aria-label={`Wallpaper ${i + 1}`} className="st-wall" style={{ backgroundImage: `url('${url}')` }} onClick={() => setSettings({ wallpaper: i })} />)}
        <button type="button" className="st-wall" aria-expanded={allWallpapers} style={{ backgroundImage: `linear-gradient(rgba(40,36,50,.55),rgba(40,36,50,.55)), url('${WALLPAPERS[VISIBLE_WALLPAPERS]}')` }} onClick={() => setAllWallpapers((open) => !open)}>{allWallpapers ? 'Less' : 'More'}</button>
      </div>
      <SwitchRow title="Glass cards" hint="Blur the photo behind widgets" checked={glass} onChange={(on) => setPrefs({ glass: on })} />
      {sliderSettings.map((s, i) => <Row key={s.title} title={s.title} hint={s.subtitle} wrap>
        <div className="st-range"><input type="range" min={0} max={100} value={sliderValues[i]} aria-label={s.title} onChange={(event) => setSettings(i === 0 ? { transparency: Number(event.target.value) } : { blur: Number(event.target.value) })} /><span className="st-hint">{sliderValues[i]}%</span></div>
      </Row>)}
      <SwitchRow title="Reduce motion" hint="Fades instead of animations. Also follows the system" checked={reduceMotion} onChange={(on) => setPrefs({ reduceMotion: on })} />
    </Card>

    <Group title="Home screen">
      <Card>
        {homeToggles.map((g, i) => <SwitchRow key={g.title} title={g.title} hint={g.subtitle} checked={toggles[i] ?? g.initial} onChange={(on) => setHomeToggle(i, on)} />)}
      </Card>
    </Group>
  </>
}

