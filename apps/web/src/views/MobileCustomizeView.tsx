import { useIsMobile } from '../lib/useIsMobile'
import { CustomizeDesktop } from './home/MobileCustomizeView.desktop'
import { CustomizeMobile } from './home/MobileCustomizeView.mobile'

export function MobileCustomizeView(_props: { theme?: 'light' | 'dark'; onToggleTheme?: () => void } = {}) {
  return useIsMobile() ? <CustomizeMobile /> : <CustomizeDesktop />
}
