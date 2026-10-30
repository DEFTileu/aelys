import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Check, Upload } from '../../icons'
import {
  accentColors,
  homeToggles,
  sliderSettings,
  themeOptions,
  VISIBLE_WALLPAPERS,
  WALLPAPERS,
  type ThemeId,
} from '../../data/desktop/settings'
import { setHomeToggle, setSettings, useDesktopState } from '../../lib/desktopStore'
import './settings.css'
import { Switch } from '../../components/Switch'

type Props = { theme: 'light' | 'dark'; onToggleTheme: () => void }

const glass: CSSProperties = {
  borderRadius: 20,
  background: 'var(--glass-bg, rgba(255,255,255,.88))',
  backdropFilter: 'blur(var(--glass-blur, 20px))',
  WebkitBackdropFilter: 'blur(var(--glass-blur, 20px))',
  border: '1px solid rgba(255,255,255,.35)',
  boxShadow: '0 8px 24px rgba(40,30,30,.07)',
}

const sectionTitle: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: '24px' }
const mutedText: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--muted, #625D69)' }
const TRAFFIC_LIGHTS = ['#FF5F57', '#FEBC2E', '#28C840']

export function SettingsScreen({ theme, onToggleTheme }: Props) {
  const [followsSystem, setFollowsSystem] = useState(false)
  const [allWallpapers, setAllWallpapers] = useState(false)
  // Wallpaper, accent and the two sliders are shared with the shell and persisted by desktopStore.
  const { accent, wallpaper: wall, customWallpaper, transparency, blur } = useDesktopState()
  const sliderValues = [transparency, blur]
  const { homeToggles: toggles } = useDesktopState()

  // The app has a single light/dark prop; "System" is resolved once at pick time.
  const selectedTheme: ThemeId = followsSystem ? 'system' : theme

  function pickTheme(id: ThemeId) {
    setFollowsSystem(id === 'system')
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
    const wanted = id === 'system' ? (systemDark ? 'dark' : 'light') : id
    if (wanted !== theme) onToggleTheme()
  }

  function setSlider(i: number, value: number) {
    setSettings(i === 0 ? { transparency: value } : { blur: value })
  }

  function flipToggle(i: number) {
    setHomeToggle(i, !toggles[i])
  }

  const uploadRef = useRef<HTMLInputElement>(null)
  function uploadWallpaper(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') setSettings({ wallpaper: -1, customWallpaper: reader.result })
    }, { once: true })
    reader.readAsDataURL(file)
    event.target.value = ''
  }

  return (
    <div className="settings-screen actual-settings-appearance">
      <div
        data-glass=""
        className="actual-appearance-content"
        style={{
          ...glass,
          minWidth: 0,
          overflowY: 'auto',
          scrollbarWidth: 'thin',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: '30px' }}>Appearance</h2>
          <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--muted, #625D69)' }}>Theme, wallpaper and visual effects</div>
        </div>

        <section aria-label="Interface theme">
          <h3 style={{ ...sectionTitle, marginBottom: 12 }}>Interface theme</h3>
          <div className="actual-theme-grid" role="radiogroup" aria-label="Interface theme" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            {themeOptions.map(t => {
              const on = selectedTheme === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pickTheme(t.id)}
                  style={{
                    display: 'block',
                    padding: 8,
                    borderRadius: 16,
                    border: `2px solid ${on ? '#6A4CF2' : 'var(--line-strong, #ECE7E3)'}`,
                    background: on ? 'var(--surface-selected, #F3F0FE)' : 'var(--surface-solid, #fff)',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ position: 'relative', height: 84, borderRadius: 10, background: t.preview, padding: 10 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {TRAFFIC_LIGHTS.map(c => (
                        <span key={c} style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
                      ))}
                    </div>
                    <div style={{ position: 'absolute', left: 44, right: 20, top: 20, bottom: 12, borderRadius: 7, background: t.panel }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, padding: '0 4px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 600 }}>{t.title}</div>
                      <div style={mutedText}>{t.subtitle}</div>
                    </div>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 20,
                        height: 20,
                        flex: 'none',
                        borderRadius: '50%',
                        border: on ? 'none' : '1.5px solid #BDB7C2',
                        background: on ? '#6A4CF2' : 'transparent',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {on && <Check size={12} />}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section aria-label="Accent color">
          <h3 style={{ ...sectionTitle, marginBottom: 12 }}>Accent color</h3>
          <div className="actual-accent-grid" role="radiogroup" aria-label="Accent color" style={{ display: 'flex', gap: 16 }}>
            {accentColors.map((a, i) => {
              const on = accent === i
              return (
                <button
                  key={a.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={a.name}
                  onClick={() => setSettings({ accent: i })}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: a.color,
                    boxShadow: on ? '0 0 0 3px #fff,0 0 0 5px #6A4CF2' : 'none',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {on && <Check size={16} aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </section>

        <section aria-label="Wallpaper">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <h3 style={sectionTitle}>Wallpaper</h3>
              <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--muted, #625D69)' }}>Pick a background or use your own image</div>
            </div>
            <input ref={uploadRef} type="file" accept="image/*" onChange={uploadWallpaper} style={{ display: 'none' }} />
            <button type="button" className="settings-upload" onClick={() => uploadRef.current?.click()}>
              <Upload size={16} aria-hidden="true" />
              Upload photo
            </button>
          </div>
          <div className="actual-wallpaper-grid" role="group" aria-label="Wallpapers" style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12 }}>
            {customWallpaper && <button type="button" role="radio" aria-checked={wall === -1} aria-label="Uploaded wallpaper" onClick={() => setSettings({ wallpaper: -1 })} style={{ position: 'relative', height: 88, borderRadius: 12, background: `url('${customWallpaper}') center/cover`, boxShadow: wall === -1 ? '0 0 0 3px #6A4CF2' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 600 }}>Uploaded</button>}
            {(allWallpapers ? WALLPAPERS : WALLPAPERS.slice(0, VISIBLE_WALLPAPERS)).map((url, i) => {
              const on = wall === i
              return (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`Wallpaper ${i + 1}`}
                  onClick={() => setSettings({ wallpaper: i })}
                  style={{ position: 'relative', height: 88, borderRadius: 12, background: `url('${url}') center/cover`, boxShadow: on ? '0 0 0 3px #6A4CF2' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 600 }}
                >
                  {on && (
                    <span
                      aria-hidden="true"
                      style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: '50%', background: '#6A4CF2', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Check size={11} />
                    </span>
                  )}
                </button>
              )
            })}
            <button
              type="button"
              aria-expanded={allWallpapers}
              onClick={() => setAllWallpapers((open) => !open)}
              style={{ position: 'relative', height: 88, borderRadius: 12, background: `linear-gradient(rgba(40,36,50,.55),rgba(40,36,50,.55)), url('${WALLPAPERS[VISIBLE_WALLPAPERS]}') center/cover`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 600 }}
            >
              {allWallpapers ? 'Less' : 'More'}
            </button>
          </div>
          <div className="actual-appearance-pair" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            {sliderSettings.map((s, i) => (
              <div key={s.title} style={{ padding: '12px 14px', borderRadius: 14, background: 'var(--surface-soft, #F7F4F1)' }}>
                <div style={{ display: 'flex', fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>
                  <span style={{ flex: 1 }}>{s.title}</span>
                  <span>{sliderValues[i]}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={sliderValues[i]}
                  aria-label={s.title}
                  onChange={e => setSlider(i, Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#6A4CF2', margin: '8px 0 4px' }}
                />
                <div style={mutedText}>{s.subtitle}</div>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Home screen">
          <h3 style={sectionTitle}>Home screen</h3>
          <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--muted, #625D69)', marginBottom: 12 }}>Choose what the home screen shows</div>
          <div className="actual-appearance-pair" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
            {homeToggles.map((g, i) => {
              const on = toggles[i]
              const Icon = g.icon
              return (
                <div key={g.title} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 14, background: 'var(--surface-soft, #F7F4F1)' }}>
                  <span style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: 'var(--surface-solid, #fff)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{g.title}</div>
                    <div style={mutedText}>{g.subtitle}</div>
                  </div>
                  <Switch label={g.title} checked={on} onCheckedChange={() => flipToggle(i)} />
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
