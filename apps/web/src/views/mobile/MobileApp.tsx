import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Mic, Plus } from 'lucide-react'
import { accentOf } from '../../data/desktop/home'
import { WALLPAPERS } from '../../data/desktop/settings'
import { DEFAULT_QUICK_ACTIONS, QUICK_ACTIONS, readMobileWidgets, saveMobileWidgets, type MobileWidget } from '../../data/mobile'
import { askAelys, takePendingAsk, useDesktopState } from '../../lib/desktopStore'
import { navigate } from '../../lib/router'
import type { RoutePath } from '../../types'
import { MobileChat, type SentMessage } from './MobileChat'
import { MobileCustomize } from './MobileCustomize'
import { MobileHome } from './MobileHome'
import './mobile.css'

type Screen = 'home' | 'custom' | 'chat'

// Photo band height, wallpaper image height and bottom padding per screen, from the design's phone frames.
const LAYOUT: Record<Screen, { photo: number; image: number; padBottom: number }> = {
  home: { photo: 460, image: 520, padBottom: 190 },
  custom: { photo: 340, image: 440, padBottom: 110 },
  chat: { photo: 400, image: 480, padBottom: 120 },
}

const ORB_BG = 'radial-gradient(circle at 32% 28%,#fff 0,rgba(235,225,255,.9) 9%,transparent 28%),radial-gradient(circle at 72% 72%,#FF7AD9 0,transparent 48%),radial-gradient(circle at 24% 72%,#46D2FF 0,transparent 46%),radial-gradient(circle at 50% 50%,#6E4CF5 0,#2A1590 82%)'

const nowTime = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// Phone layout: Home, Customize home and AI Chat. Other routes have no phone design and fall back to Home.
export function MobileApp({ route, theme, onToggleTheme }: { route: RoutePath; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [customizing, setCustomizing] = useState(false)
  const [widgets, setWidgets] = useState(readMobileWidgets)
  const [actions, setActions] = useState(DEFAULT_QUICK_ACTIONS)
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<SentMessage[]>([])
  const { wallpaper, pendingAsk } = useDesktopState()
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const screen: Screen = route === '/ai' ? 'chat' : customizing ? 'custom' : 'home'
  const layout = LAYOUT[screen]
  const wallpaperUrl = WALLPAPERS[wallpaper] ?? WALLPAPERS[0]

  // A question asked from Home (composer or chip) lands here as a sent message.
  useEffect(() => {
    if (screen !== 'chat') return
    const text = takePendingAsk()
    if (text) setSent((list) => [...list, { text, time: nowTime() }])
  }, [screen, pendingAsk])

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [screen])
  useEffect(() => { if (screen === 'chat' && sent.length) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [screen, sent.length])

  const updateWidgets = (next: MobileWidget[]) => { setWidgets(next); saveMobileWidgets(next) }
  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    if (screen === 'chat') setSent((list) => [...list, { text, time: nowTime() }])
    else askAelys(text)
  }

  return <div className="m-root" data-screen-label={screen}>
    <div className="m-photo" aria-hidden="true" style={{ height: layout.photo, backgroundImage: `url('${wallpaperUrl}')`, backgroundSize: `auto ${layout.image}px` }} />
    <div className="m-shade" aria-hidden="true" style={{ height: layout.photo }} />

    <div ref={scrollRef} className="m-scroll" style={{ paddingBottom: `calc(${layout.padBottom}px + env(safe-area-inset-bottom))` }}>
      {screen === 'home' && <MobileHome widgets={widgets} wallpaper={wallpaperUrl} onCustomize={() => setCustomizing(true)} onSearch={() => inputRef.current?.focus()} />}
      {screen === 'custom' && <MobileCustomize widgets={widgets} onWidgets={updateWidgets} actions={actions} onActions={setActions} theme={theme} onTheme={(next) => { if (next !== theme) onToggleTheme() }} onBack={() => setCustomizing(false)} />}
      {screen === 'chat' && <MobileChat sent={sent} onNewChat={() => setSent([])} />}
    </div>

    {screen === 'custom'
      ? <button type="button" className="m-btn" onClick={() => navigate('/ai')} style={{ position: 'absolute', right: 16, bottom: 'calc(28px + env(safe-area-inset-bottom))', height: 48, padding: '0 18px 0 6px', borderRadius: 24, background: '#1C1B22', color: '#fff', display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, boxShadow: '0 10px 28px rgba(20,10,30,.3)' }}>
          <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: '50%', background: ORB_BG }} />Ask Aelys
        </button>
      : <div className="m-bar">
          <form style={{ display: 'flex', alignItems: 'center', gap: 8 }} onSubmit={(event) => { event.preventDefault(); send() }}>
            <label className="m-input">
              <input ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={screen === 'chat' ? 'Message Aelys' : 'Ask or search'} aria-label={screen === 'chat' ? 'Message Aelys' : 'Ask or search'} enterKeyHint="send" />
              <button type="button" className="m-btn m-tile" aria-label="Attach or add" style={{ width: 36, height: 36, borderRadius: '50%' }}><Plus size={20} aria-hidden="true" /></button>
            </label>
            {draft.trim()
              ? <button type="submit" className="m-btn m-orb" aria-label="Send"><ArrowUp size={20} aria-hidden="true" /></button>
              : <button type="button" className="m-btn m-orb" aria-label="Voice input"><Mic size={20} aria-hidden="true" /></button>}
          </form>
          {screen === 'home' && <div className="m-chips">
            {QUICK_ACTIONS.filter((_, i) => actions[i]).map(({ title, icon: Icon, color }) => <button key={title} type="button" className="m-btn m-chip" onClick={() => askAelys(title)}><Icon size={16} color={accentOf(color).c} aria-hidden="true" />{title}</button>)}
          </div>}
        </div>}
  </div>
}
