import type { SVGProps } from 'react'
import * as icons from '../icons'
import type { GlyphName } from '../icons/glyphs'

type IconName =
  | 'home' | 'sparkles' | 'check-square' | 'calendar' | 'folder' | 'note' | 'mail' | 'wallet'
  | 'timer' | 'terminal' | 'workflow' | 'book' | 'search' | 'settings' | 'grid' | 'chevron-right'
  | 'plus' | 'arrow-up' | 'moon' | 'sun' | 'menu' | 'x' | 'refresh' | 'cloud-off' | 'wifi'
  | 'alert' | 'inbox' | 'sliders' | 'arrow-left' | 'send' | 'external' | 'lock' | 'bell' | 'more-horizontal'


const names: Record<IconName, GlyphName> = {
  'home': 'House',
  'sparkles': 'Sparkles',
  'check-square': 'SquareCheck',
  'calendar': 'Calendar',
  'folder': 'Folder',
  'note': 'NotebookText',
  'mail': 'Mail',
  'wallet': 'Wallet',
  'timer': 'Timer',
  'terminal': 'Terminal',
  'workflow': 'Workflow',
  'book': 'BookOpen',
  'search': 'Search',
  'settings': 'Settings',
  'grid': 'LayoutGrid',
  'chevron-right': 'ChevronRight',
  'plus': 'Plus',
  'arrow-up': 'ArrowUp',
  'moon': 'Moon',
  'sun': 'Sun',
  'menu': 'Menu',
  'x': 'X',
  'refresh': 'RefreshCw',
  'cloud-off': 'CloudOff',
  'wifi': 'Wifi',
  'alert': 'TriangleAlert',
  'inbox': 'Inbox',
  'sliders': 'Sliders',
  'arrow-left': 'ArrowLeft',
  'send': 'Send',
  'external': 'External',
  'lock': 'Lock',
  'bell': 'Bell',
  'more-horizontal': 'Ellipsis',
}

/** Named compatibility surface; all paths come from the Aelys icon family. */
export function Icon({ name, size = 18, strokeWidth = 1.75, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number; strokeWidth?: number }) {
  const Glyph = icons[names[name]]
  return <Glyph size={size} strokeWidth={strokeWidth} {...props} />
}
