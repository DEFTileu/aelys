import {
  Blocks,
  History,
  House,
  Keyboard,
  LayoutGrid,
  LayoutPanelLeft,
  Paintbrush,
  RefreshCw,
  Shield,
  Sparkles,
  User,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// Stand-in for the design's assets/wallpaper.png, which is not available in the app.
export const SETTINGS_WALLPAPER = '/backgrounds/weather/08_evening_sunset.jpg'

export type SettingsNavItem = { title: string; subtitle: string; icon: LucideIcon; active?: boolean }

export const settingsNav: SettingsNavItem[] = [
  { title: 'Profile', subtitle: 'Personal data and account', icon: User },
  { title: 'Appearance', subtitle: 'Theme, wallpaper, styling', icon: Paintbrush, active: true },
  { title: 'Home screen', subtitle: 'Blocks and widgets', icon: LayoutPanelLeft },
  { title: 'Widgets', subtitle: 'Widget settings', icon: LayoutGrid },
  { title: 'AI & models', subtitle: 'Models and parameters', icon: Sparkles },
  { title: 'Integrations', subtitle: 'Connected services', icon: Blocks },
  { title: 'Sync', subtitle: 'Data across devices', icon: RefreshCw },
  { title: 'Shortcuts', subtitle: 'Quick access', icon: Keyboard },
  { title: 'Privacy', subtitle: 'Security and data', icon: Shield },
]

export type ThemeId = 'light' | 'system' | 'dark'

export type ThemeOption = { id: ThemeId; title: string; subtitle: string; preview: string; panel: string }

export const themeOptions: ThemeOption[] = [
  { id: 'light', title: 'Light', subtitle: 'Clean and minimal', preview: 'linear-gradient(135deg,#F4D6D6,#E8E6F4)', panel: 'rgba(255,255,255,.9)' },
  { id: 'system', title: 'System', subtitle: 'Follows macOS', preview: 'linear-gradient(180deg,#9AA6CC,#F0B79C 55%,#5A5F7E)', panel: 'rgba(255,255,255,.7)' },
  { id: 'dark', title: 'Dark', subtitle: 'Comfortable at night', preview: 'linear-gradient(180deg,#2E3346,#1E2230)', panel: 'rgba(80,85,100,.8)' },
]

export const accentColors: { name: string; color: string }[] = [
  { name: 'Violet', color: '#6A4CF2' },
  { name: 'Blue', color: '#2F6FE4' },
  { name: 'Cyan', color: '#0FA3B8' },
  { name: 'Green', color: '#14966C' },
  { name: 'Orange', color: '#EA7A12' },
  { name: 'Pink', color: '#D9367E' },
  { name: 'Red', color: '#D93636' },
  { name: 'Multicolor', color: 'conic-gradient(#F87171,#FBBF24,#34D399,#60A5FA,#A78BFA,#F87171)' },
]

const WALL_URL = `url('${SETTINGS_WALLPAPER}')`

export type WallpaperTile = { background: string; label?: string }

export const wallpaperTiles: WallpaperTile[] = [
  ...['82% 30%', '55% 40%', '30% 50%', '95% 20%', '10% 60%'].map(pos => ({ background: `${WALL_URL} ${pos}/auto 260px` })),
  { background: `linear-gradient(rgba(40,36,50,.55),rgba(40,36,50,.55)), ${WALL_URL} 70% 40%/auto 260px`, label: 'More' },
]

export const sliderSettings: { title: string; subtitle: string; initial: number }[] = [
  { title: 'Interface transparency', subtitle: 'How see-through panels and cards are', initial: 70 },
  { title: 'Background blur', subtitle: 'Strength of the blur effect', initial: 40 },
]

export const homeToggles: { title: string; subtitle: string; icon: LucideIcon; initial: boolean }[] = [
  { title: 'Greeting', subtitle: 'Personal greeting and motivation', icon: House, initial: true },
  { title: 'Widgets', subtitle: 'Widgets on the home screen', icon: LayoutGrid, initial: true },
  { title: 'Quick actions', subtitle: 'Create tasks, notes and projects', icon: Zap, initial: true },
  { title: 'Recent activity', subtitle: 'Latest actions and events', icon: History, initial: true },
]
