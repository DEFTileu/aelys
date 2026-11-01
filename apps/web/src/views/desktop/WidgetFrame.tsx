import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { normalizeWidgetSize, WIDGET_GRID_GAP, WIDGET_GRID_ROW, WIDGET_SIZES, type WidgetId, type WidgetSize } from './homeLayout'

export type WidgetFrameControls = {
  id: WidgetId
  /** Unique per card: a widget may appear twice at different sizes. */
  itemKey: string
  title: string
  span: number
  height?: number
  onDrop: (source: string, target: string) => void
  onMove: (delta: -1 | 1) => void
  onSize: (span: number, height: number) => void
}

type Gesture = { kind: 'move' | 'resize'; x: number; y: number; width: number; height: number; column: number; gap: number; columns: number; row: number; moved: boolean; target?: string }
const ARROWS = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']
const LONG_PRESS_MS = 500

/** Direct manipulation: drag the card to move, drag the corner to resize (snaps to S / M / L / Tall). */
export function WidgetFrame({ controls, style, children, editing, onRemove, onLongPress }: {
  controls: WidgetFrameControls; style: CSSProperties; children: ReactNode | ((size: WidgetSize) => ReactNode); editing: boolean
  onRemove: () => void; onLongPress?: () => void
}) {
  const article = useRef<HTMLElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const previewRef = useRef<WidgetSize | null>(null)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const [moving, setMoving] = useState(false)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [preview, setPreview] = useState<WidgetSize | null>(null)
  const size = normalizeWidgetSize(controls.span, controls.height)
  const activeSize = preview ?? size
  const clearTargets = () => article.current?.parentElement?.querySelectorAll('[data-drop-target]').forEach(card => card.removeAttribute('data-drop-target'))
  const clearPress = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = null }
  const cancel = () => {
    gesture.current = null; previewRef.current = null; clearTargets()
    setMoving(false); setOffset({ x: 0, y: 0 }); setPreview(null)
  }
  useEffect(() => { if (!editing) cancel() }, [editing])
  useEffect(() => () => { clearTargets(); clearPress() }, [])
  const begin = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (!editing || event.button !== 0 || gesture.current) return
    const node = article.current
    if (!node?.parentElement) return
    event.preventDefault()
    const rect = node.getBoundingClientRect()
    const grid = getComputedStyle(node.parentElement)
    const columns = grid.gridTemplateColumns.split(' ').filter(Boolean).length || 1
    const gap = Number.parseFloat(grid.columnGap) || WIDGET_GRID_GAP
    const padding = (Number.parseFloat(grid.paddingLeft) || 0) + (Number.parseFloat(grid.paddingRight) || 0)
    const column = (node.parentElement.getBoundingClientRect().width - padding - gap * (columns - 1)) / columns
    gesture.current = { kind, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, column, gap, columns, row: Number.parseFloat(grid.gridAutoRows) || ((rect.height + gap) / size.rows - gap), moved: false }
    node.setPointerCapture?.(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) clearPress()
    const drag = gesture.current
    if (!editing || !drag) return
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    if (drag.kind === 'resize') {
      // Compare actual pixel distances to the four presets. No freeform height.
      const available = WIDGET_SIZES.filter(item => drag.columns === 1 ? item.span === size.span : item.span <= drag.columns)
      const nearest = available.reduce((best, item) => {
        const distance = (candidate: typeof item) => Math.hypot((Math.min(drag.columns, candidate.span) * (drag.column + drag.gap) - drag.gap) - (drag.width + dx), (candidate.rows * (drag.row + drag.gap) - drag.gap) - (drag.height + dy))
        return distance(item) < distance(best) ? item : best
      }, available[0])
      const next = normalizeWidgetSize(nearest.span, nearest.height)
      previewRef.current = next; setPreview(next)
    } else {
      setMoving(true); setOffset({ x: dx, y: dy })
      const grid = article.current?.parentElement
      if (!grid) return
      const cards = [...grid.querySelectorAll<HTMLElement>('[data-widget-key]')]
      const target = cards.find(card => {
        if (card === article.current) return false
        const rect = card.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      })
      drag.target = target?.dataset.widgetKey
      cards.forEach(card => card.toggleAttribute('data-drop-target', card === target))
      const viewport = grid.closest('.shell-main') ?? document.scrollingElement
      if (viewport) {
        const rect = viewport.getBoundingClientRect()
        if (event.clientY > rect.bottom - 64) viewport.scrollTop += 18
        else if (event.clientY < rect.top + 64) viewport.scrollTop -= 18
      }
    }
  }
  const finish = (cancelled: boolean) => {
    clearPress()
    const drag = gesture.current
    const next = previewRef.current
    if (editing && !cancelled && drag?.moved) {
      if (drag.kind === 'resize' && next) controls.onSize(next.span, next.height)
      if (drag.kind === 'move' && drag.target && drag.target !== controls.itemKey) controls.onDrop(controls.itemKey, drag.target)
    }
    cancel()
  }
  /** Absolute targets: left/right pick the column span, up/down the row span. */
  const resizeByKey = (key: string) => {
    const span = key === 'ArrowLeft' ? 1 : key === 'ArrowRight' ? 2 : size.span
    const rows = key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? 2 : size.rows
    const next = normalizeWidgetSize(span, rows * (WIDGET_GRID_GAP + WIDGET_GRID_ROW) - WIDGET_GRID_GAP)
    controls.onSize(next.span, next.height)
  }
  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!editing) return
    if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.nativeEvent.stopPropagation(); finish(true); return }
    if (event.target !== event.currentTarget) return
    if (ARROWS.includes(event.key)) {
      event.preventDefault()
      if (event.shiftKey) resizeByKey(event.key)
      else controls.onMove(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onRemove() }
  }
  return <article ref={article} tabIndex={editing ? 0 : undefined} className={`home-widget${editing ? ' home-widget--editing' : ''}${moving ? ' home-widget--moving' : ''}${preview ? ' home-widget--resizing' : ''}`} aria-label={controls.title} aria-description={editing ? 'Arrow keys move, Shift and arrow keys resize, Delete removes' : undefined} data-widget-id={controls.id} data-widget-key={controls.itemKey} data-size-key={activeSize.key} data-size={activeSize.id} data-rows={activeSize.rows} data-glass="" style={{ ...style, '--widget-span': activeSize.span, '--widget-rows': activeSize.rows, transform: moving ? `translate(${offset.x}px,${offset.y}px)` : undefined, zIndex: moving ? 20 : undefined } as CSSProperties}
    onPointerDown={event => {
      if ((event.target as HTMLElement).closest('button,a,input,select,textarea')) return
      if (editing) { begin(event, 'move'); return }
      if (onLongPress && event.button === 0) { clearPress(); press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => { press.current = null; onLongPress() }, LONG_PRESS_MS) } }
    }}
    onPointerMove={move} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onKeyDown={onCardKeyDown}>
    {editing && <button type="button" className="home-btn home-remove-widget" aria-label={`Remove ${controls.title}`} onClick={onRemove}><span aria-hidden="true">−</span></button>}
    <div className="home-widget-drag-bar">{typeof children === 'function' ? children(activeSize) : children}</div>
    {editing && <>
      {preview && <span className="home-size-badge" role="status">{preview.key} · {preview.span}×{preview.rows}</span>}
      <button type="button" className="home-btn home-resize-handle" aria-label={`Resize ${controls.title}`} title="Drag to resize" onPointerDown={event => begin(event, 'resize')} onKeyDown={event => {
        if (event.key === 'Escape') return
        if (!ARROWS.includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        resizeByKey(event.key)
      }}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M13 4 4 13M13 8.5 8.5 13" /></svg></button>
    </>}
  </article>
}
