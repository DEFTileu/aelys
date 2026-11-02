import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApiStatus } from '../types'
import { PageSkeleton } from './PageSkeleton'

/**
 * The one place that reacts to a lost connection. Offline with nothing loaded on this screen: the full "Can't reach Aelys" card.
 * Offline after data arrived: the screen stays and a quiet toast says so once per outage.
 */
export function OfflineGate({ route, apiStatus, compact, children }: { route: string; apiStatus: ApiStatus; compact: boolean; children: ReactNode }) {
  const [hadData, setHadData] = useState(false)
  const [toast, setToast] = useState(false)
  const shown = useRef(false)
  useEffect(() => { setHadData(false); shown.current = false; setToast(false) }, [route])
  useEffect(() => {
    if (apiStatus === 'ready' || apiStatus === 'empty') { setHadData(true); shown.current = false; return }
    if (apiStatus !== 'offline' || !hadData || shown.current) return
    shown.current = true; setToast(true)
    const timer = window.setTimeout(() => setToast(false), 4000)
    return () => window.clearTimeout(timer)
  }, [apiStatus, hadData])
  if (apiStatus === 'offline' && !hadData) return <PageSkeleton kind="list" phase="error" compact={compact} label="this page" onRetry={() => window.dispatchEvent(new Event('aelys:check-api'))} />
  return <>{children}{toast && <div className="offline-toast" role="status">Offline · changes will sync</div>}</>
}
