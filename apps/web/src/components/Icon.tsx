import type { SVGProps } from 'react'

type IconName =
  | 'home' | 'sparkles' | 'check-square' | 'calendar' | 'folder' | 'note' | 'mail' | 'wallet'
  | 'timer' | 'terminal' | 'workflow' | 'search' | 'settings' | 'grid' | 'chevron-right'
  | 'plus' | 'arrow-up' | 'moon' | 'sun' | 'menu' | 'x' | 'refresh' | 'cloud-off' | 'wifi'
  | 'alert' | 'inbox' | 'sliders' | 'arrow-left' | 'send' | 'external' | 'lock' | 'bell' | 'more-horizontal'

const paths: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9Z',
  sparkles: 'm12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Zm7 11 .7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7L19 14ZM5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15Z',
  'check-square': 'M9 11 11 13 15 9M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v13H3V6a2 2 0 0 1 2-2Zm-2 5h18M8 2v4m8-4v4',
  folder: 'M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  note: 'M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm9 0v5h4M8 12h8M8 16h6',
  mail: 'M3 5h18v14H3V5Zm1 1 8 7 8-7',
  wallet: 'M4 6h16a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1h16M16 13h6',
  timer: 'M9 2h6M12 5v7l4 2M19.1 7.1l1.4-1.4M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z',
  terminal: 'm4 5 6 6-6 6m8 0h8',
  workflow: 'M6 3v5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V3M6 21v-5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v5M3 3h6M15 3h6M3 21h6M15 21h6',
  search: 'm21 21-4.4-4.4m2.4-5.6a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  grid: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  'chevron-right': 'm9 18 6-6-6-6',
  plus: 'M12 5v14M5 12h14',
  'arrow-up': 'm5 12 7-7 7 7M12 5v14',
  moon: 'M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'm6 6 12 12M18 6 6 18',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9L3 10m0-4v4h4m-3 3a8 8 0 0 0 14.9 3.9L21 14m0 4v-4h-4',
  'cloud-off': 'm3 3 18 18M10.6 5.1A7 7 0 0 1 19 11a5 5 0 0 1 1.7 9H7a5 5 0 0 1-1.4-9.8M3 16a4.5 4.5 0 0 1 3.2-4.3',
  wifi: 'M5 12.5a11 11 0 0 1 14 0M8 16a6.5 6.5 0 0 1 8 0M11 19h.01',
  alert: 'M12 3 2 21h20L12 3Zm0 6v5m0 4h.01',
  inbox: 'M4 4h16v14H4V4Zm0 9h4l1.5 2h5L16 13h4',
  sliders: 'M4 6h16M4 18h16M8 4v4M16 16v4',
  'arrow-left': 'm15 18-6-6 6-6M9 12h12',
  send: 'm22 2-7 20-4-9-9-4 20-7Z',
  external: 'M14 5h5v5m-1-4-8 8M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3m-11 0h12v10H6V10Z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  'more-horizontal': 'M5 12h.01M12 12h.01M19 12h.01',
}

export function Icon({ name, size = 18, strokeWidth = 1.8, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={paths[name]} />
    </svg>
  )
}
