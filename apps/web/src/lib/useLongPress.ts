import { useEffect, useRef } from 'react'

// Touch and mouse long-press. Any move or release before the delay cancels it, so scrolling never triggers it.
export function useLongPress(onLongPress: () => void, delay = 500) {
  const timer = useRef<number | undefined>(undefined)
  const cancel = () => { window.clearTimeout(timer.current); timer.current = undefined }
  useEffect(() => cancel, [])
  return {
    onPointerDown: () => { cancel(); timer.current = window.setTimeout(onLongPress, delay) },
    onPointerUp: cancel,
    onPointerMove: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  }
}
