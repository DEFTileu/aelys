import { useEffect } from 'react'
import { useIsMobile } from './useIsMobile'

// Mirrors the mobile breakpoint onto <html data-layout> so global stylesheets can scope mobile rules without media queries.
export function useLayoutMode() {
  const mobile = useIsMobile()
  useEffect(() => { document.documentElement.dataset.layout = mobile ? 'mobile' : 'desktop' }, [mobile])
}
