import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Puts a subtitle and an action pill into the phone shell's header, where the design keeps them for every inner
 * screen. Outside the phone shell the slots do not exist, so it renders nothing.
 */
export function MobileHeader({ sub, action }: { sub?: ReactNode; action?: ReactNode }) {
  const [slots, setSlots] = useState<{ sub: HTMLElement | null; action: HTMLElement | null }>({ sub: null, action: null })
  useLayoutEffect(() => setSlots({ sub: document.getElementById('mobile-header-sub'), action: document.getElementById('mobile-header-action') }), [])
  return <>
    {sub && slots.sub && createPortal(<span>{sub}</span>, slots.sub)}
    {action && slots.action && createPortal(action, slots.action)}
  </>
}
