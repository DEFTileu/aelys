import { StyledSelect } from '../../components/controls/StyledSelect'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, GripVertical, Scaling } from '../../icons'
import { normalizeWidgetSize, WIDGET_GRID_ROW, WIDGET_GRID_GAP, WIDGET_SIZES, type WidgetId } from './homeLayout'

export type WidgetFrameControls = {
  id: WidgetId
  title: string
  span: number
  height?: number
  automatic?: boolean
  onAuto?: () => void
  onDrop: (source: WidgetId, target: WidgetId) => void
  onMove: (delta: -1 | 1) => void
  onSize: (span: number, height: number) => void
}

type Gesture = { kind: 'move' | 'resize'; x: number; y: number; width: number; height: number; column: number; gap: number; columns: number; row: number; moved: boolean; target?: WidgetId }

/** Editing is explicit. Both pointer previews and persisted sizes use tile units. */
export function WidgetFrame({ controls, style, children, editing, onRemove, canMoveEarlier, canMoveLater }: {
  controls: WidgetFrameControls; style: CSSProperties; children: ReactNode | ((size: ReturnType<typeof normalizeWidgetSize>) => ReactNode); editing: boolean
  onRemove: () => void; canMoveEarlier: boolean; canMoveLater: boolean
}) {
  const article = useRef<HTMLElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const previewRef = useRef<{ span: number; height: number; rows: number } | null>(null)
  const [moving, setMoving] = useState(false)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [preview, setPreview] = useState<{ span: number; height: number; rows: number } | null>(null)
  const size = normalizeWidgetSize(controls.span, controls.height)
  const activeSize = preview ?? size
  const clearTargets = () => article.current?.parentElement?.querySelectorAll('[data-drop-target]').forEach(card => card.removeAttribute('data-drop-target'))
  const cancel = () => {
    gesture.current = null; previewRef.current = null; clearTargets()
    setMoving(false); setOffset({ x: 0, y: 0 }); setPreview(null)
  }
  useEffect(() => { if (!editing) cancel() }, [editing])
  useEffect(() => () => { clearTargets() }, [])
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
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = gesture.current
    if (!editing || !drag) return
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    if (drag.kind === 'resize') {
      // Compare actual pixel distances to preset rectangles. No freeform height.
      const available = WIDGET_SIZES.filter(item => drag.columns === 1 ? item.span === size.span : item.span <= drag.columns)
      const nearest = available.reduce((best, item) => {
        const distance = (candidate: typeof item) => Math.hypot((Math.min(drag.columns, candidate.span) * (drag.column + drag.gap) - drag.gap) - (drag.width + dx), (candidate.rows * (drag.row + drag.gap) - drag.gap) - (drag.height + dy))
        return distance(item) < distance(best) ? item : best
      }, available[0])
      const next = { span: nearest.span, height: nearest.height, rows: nearest.rows }
      previewRef.current = next; setPreview(next)
    } else {
      setMoving(true); setOffset({ x: dx, y: dy })
      const grid = article.current?.parentElement
      if (!grid) return
      const cards = [...grid.querySelectorAll<HTMLElement>('[data-widget-id]')]
      const target = cards.find(card => {
        if (card === article.current) return false
        const rect = card.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      })
      drag.target = target?.dataset.widgetId as WidgetId | undefined
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
    const drag = gesture.current
    const next = previewRef.current
    if (editing && !cancelled && drag?.moved) {
      if (drag.kind === 'resize' && next) controls.onSize(next.span, next.height)
      if (drag.kind === 'move' && drag.target && drag.target !== controls.id) controls.onDrop(controls.id, drag.target)
    }
    cancel()
  }
  const pointerHandlers = { onPointerMove: move, onPointerUp: () => finish(false), onPointerCancel: () => finish(true), onLostPointerCapture: () => finish(true) }
  const currentPreset = WIDGET_SIZES.find(item => item.span === size.span && item.height === size.height) ?? WIDGET_SIZES[0]
  return <article ref={article} className={`home-widget${editing ? ' home-widget--editing' : ''}${moving ? ' home-widget--moving' : ''}`} aria-label={controls.title} data-widget-id={controls.id} data-size={WIDGET_SIZES.find(item => item.span === activeSize.span && item.height === activeSize.height)?.id ?? currentPreset.id} data-sizing={controls.automatic ? 'auto' : 'manual'} data-rows={activeSize.rows} data-glass="" style={{ ...style, '--widget-span': activeSize.span, '--widget-rows': activeSize.rows, height: activeSize.height, transform: moving ? `translate(${offset.x}px,${offset.y}px)` : undefined, zIndex: moving ? 20 : undefined } as CSSProperties} onKeyDown={event => { if (editing && event.key === 'Escape' && gesture.current) { event.preventDefault(); finish(true) } }}>
    {editing && <button type="button" className="home-btn home-remove-widget" aria-label={`Remove ${controls.title}`} onClick={onRemove}><span aria-hidden="true">−</span></button>}
    <div className="home-widget-drag-bar" onPointerDown={event => {
      if (editing && !(event.target as HTMLElement).closest('button,a,input,select,textarea')) begin(event, 'move')
    }} {...pointerHandlers}>
      {editing && <button type="button" className="home-btn home-drag-handle" aria-label={`Move ${controls.title}`} title="Drag to move" onPointerDown={event => begin(event, 'move')} onKeyDown={event => {
        if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); controls.onMove(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) }
        if (event.key === 'Escape') finish(true)
      }}><GripVertical size={16} aria-hidden="true" /></button>}
      {typeof children === 'function' ? children(activeSize) : children}
    </div>
    {editing && <>
      <div className="home-widget-edit-tools" role="group" aria-label={`${controls.title} widget controls`}>
        <button type="button" className="home-btn home-control" aria-label={`Move ${controls.title} earlier`} title="Move earlier" disabled={!canMoveEarlier} onClick={() => controls.onMove(-1)}><ChevronUp size={16} /></button>
        <button type="button" className="home-btn home-control" aria-label={`Move ${controls.title} later`} title="Move later" disabled={!canMoveLater} onClick={() => controls.onMove(1)}><ChevronDown size={16} /></button>
        <StyledSelect aria-label={`Size of ${controls.title}`} title="Auto or width × height in tiles" value={controls.automatic ? 'auto' : currentPreset.id} onChange={event => { if (event.target.value === 'auto') { controls.onAuto?.(); return }; const next = WIDGET_SIZES.find(item => item.id === event.target.value)!; controls.onSize(next.span, next.height) }}>{controls.onAuto && <option value="auto">Auto</option>}{WIDGET_SIZES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</StyledSelect>
      </div>
      <button type="button" className="home-btn home-resize-handle" aria-label={`Resize ${controls.title}`} title="Drag to resize to a tile" onPointerDown={event => begin(event, 'resize')} {...pointerHandlers} onKeyDown={event => {
        if (event.key === 'Escape') { finish(true); return }
        if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        const widths = [1, 2, 4]
        const widthIndex = widths.indexOf(size.span)
        const span = event.key === 'ArrowLeft' ? widths[Math.max(0, widthIndex - 1)] : event.key === 'ArrowRight' ? widths[Math.min(widths.length - 1, widthIndex + 1)] : size.span
        const rows = event.key === 'ArrowUp' ? Math.max(1, size.rows - 1) : event.key === 'ArrowDown' ? Math.min(3, size.rows + 1) : size.rows
        const next = normalizeWidgetSize(span, rows * (WIDGET_GRID_GAP + WIDGET_GRID_ROW) - WIDGET_GRID_GAP)
        controls.onSize(next.span, next.height)
      }}><Scaling size={18} aria-hidden="true" /></button>
    </>}
  </article>
}
