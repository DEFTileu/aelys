import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { GOAL_W, HH, HW, MALLET_R, PUCK_R, SNAKE_N, WIN_SCORE, clampMallet, newHockey, newSnake, stepHockey, stepSnake, type Hockey, type SnakeState } from '../lib/arcade'
import type { Direction } from '../lib/games'

/** Real-time games on <canvas>. Game state lives in refs and React re-renders only on score changes; the frame loop stops on unmount or pause. */

const INK = '#1d1840', PURPLE = '#8b74ff', AMBER = '#ffb84d', GREEN = '#34d399', RED = '#ff5d73'
const CELL = 20, SNAKE_PX = SNAKE_N * CELL

/** Calls `frame(dtSeconds)` each animation frame while `active`. dt is capped so a stalled tab cannot teleport things. */
function useLoop(frame: (dt: number) => void, active: boolean) {
  const latest = useRef(frame)
  useEffect(() => { latest.current = frame })
  useEffect(() => {
    if (!active) return
    let id = 0, last = performance.now()
    const tick = (now: number) => { latest.current(Math.min((now - last) / 1000, 1 / 30)); last = now; id = requestAnimationFrame(tick) }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [active])
}

/** Sizes the backing store for the device pixel ratio (capped at 2) so lines stay sharp without a huge buffer. */
function useCanvas(width: number, height: number) {
  const ref = useRef<HTMLCanvasElement>(null)
  const ctx = useRef<CanvasRenderingContext2D | null>(null)
  useEffect(() => {
    const canvas = ref.current!, ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = width * ratio; canvas.height = height * ratio
    ctx.current = canvas.getContext('2d')
    ctx.current?.setTransform(ratio, 0, 0, ratio, 0, 0)
  }, [width, height])
  return { ref, ctx }
}

const disc = (c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) => { c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill() }

function drawHockey(c: CanvasRenderingContext2D, h: Hockey) {
  c.fillStyle = INK; c.fillRect(0, 0, HW, HH)
  c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 2
  c.beginPath(); c.moveTo(0, HH / 2); c.lineTo(HW, HH / 2); c.stroke()
  c.beginPath(); c.arc(HW / 2, HH / 2, 48, 0, Math.PI * 2); c.stroke()
  c.fillStyle = AMBER; c.fillRect((HW - GOAL_W) / 2, 0, GOAL_W, 5)
  c.fillStyle = PURPLE; c.fillRect((HW - GOAL_W) / 2, HH - 5, GOAL_W, 5)
  ;[AMBER, PURPLE].forEach((color, i) => { const m = h.mallets[i]!; disc(c, m.x, m.y, MALLET_R, color); disc(c, m.x, m.y, MALLET_R * 0.5, 'rgba(255,255,255,.35)') })
  disc(c, h.puck.x, h.puck.y, PUCK_R, '#f6f3ff')
}

export function AirHockey() {
  const { ref, ctx } = useCanvas(HW, HH)
  const game = useRef<Hockey>(newHockey(1))
  const points = useRef<[number, number]>([0, 0])
  const freezeUntil = useRef(0)
  const fingers = useRef(new Map<number, 0 | 1>()) // pointer id -> which mallet it drags, so two thumbs play at once
  const [score, setScore] = useState<[number, number]>([0, 0])
  const [running, setRunning] = useState(false)
  const winner = score[0] >= WIN_SCORE ? 0 : score[1] >= WIN_SCORE ? 1 : null

  const place = (event: PointerEvent<HTMLCanvasElement>) => {
    const player = fingers.current.get(event.pointerId)
    if (player === undefined) return
    const box = event.currentTarget.getBoundingClientRect()
    const [x, y] = clampMallet(player, (event.clientX - box.left) / box.width * HW, (event.clientY - box.top) / box.height * HH)
    const mallet = game.current.mallets[player]
    mallet.x = x; mallet.y = y
  }
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    fingers.current.set(event.pointerId, (event.clientY - box.top) / box.height < 0.5 ? 0 : 1)
    event.currentTarget.setPointerCapture(event.pointerId); place(event)
  }

  useEffect(() => { if (!running && ctx.current) drawHockey(ctx.current, game.current) }, [running, ctx, score])
  useLoop(dt => {
    if (performance.now() >= freezeUntil.current) {
      const scorer = stepHockey(game.current, dt)
      if (scorer !== null) {
        points.current[scorer]++
        const next: [number, number] = [points.current[0], points.current[1]]
        setScore(next)
        if (next[scorer] >= WIN_SCORE) setRunning(false)
        const serve = newHockey(scorer === 0 ? 1 : 0); serve.mallets = game.current.mallets // the side that conceded serves
        game.current = serve; freezeUntil.current = performance.now() + 800
      }
    }
    if (ctx.current) drawHockey(ctx.current, game.current)
  }, running)

  const start = () => { points.current = [0, 0]; setScore([0, 0]); game.current = newHockey(1); freezeUntil.current = performance.now() + 500; setRunning(true) }
  return <div className="game-stage">
    <div className="game-score"><span data-on={running} data-tone="amber">Player 1 <b>{score[0]}</b></span><span data-on={running} data-tone="purple">Player 2 <b>{score[1]}</b></span></div>
    <canvas ref={ref} className="game-canvas game-canvas--hockey" role="img" aria-label="Air hockey table. Drag your mallet with a finger or the mouse." onPointerDown={down} onPointerMove={place} onPointerUp={e => fingers.current.delete(e.pointerId)} onPointerCancel={e => fingers.current.delete(e.pointerId)} />
    <p className="game-status" aria-live="polite">{winner !== null ? `Player ${winner + 1} wins` : running ? `First to ${WIN_SCORE}` : 'Each player drags their own mallet. Best on a touchscreen with two thumbs.'}</p>
    <button type="button" className="app-btn app-btn--primary" disabled={running} onClick={start}>{winner !== null ? 'Rematch' : 'Start'}</button>
  </div>
}

function drawSnake(c: CanvasRenderingContext2D, s: SnakeState) {
  c.fillStyle = INK; c.fillRect(0, 0, SNAKE_PX, SNAKE_PX)
  c.fillStyle = 'rgba(255,255,255,.035)'
  for (let y = 0; y < SNAKE_N; y++) for (let x = (y % 2); x < SNAKE_N; x += 2) c.fillRect(x * CELL, y * CELL, CELL, CELL)
  disc(c, s.food[0] * CELL + CELL / 2, s.food[1] * CELL + CELL / 2, CELL * 0.34, AMBER)
  s.snake.forEach(([x, y], i) => {
    c.fillStyle = s.dead ? RED : i === 0 ? '#6ee7b7' : GREEN
    c.globalAlpha = Math.max(0.45, 1 - i * 0.025)
    c.beginPath(); c.roundRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2, i === 0 ? 8 : 6); c.fill()
  })
  c.globalAlpha = 1
}

const KEY_DIRECTIONS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' }

export function Snake() {
  const { ref, ctx } = useCanvas(SNAKE_PX, SNAKE_PX)
  const state = useRef<SnakeState>(newSnake())
  const want = useRef<Direction>('right')
  const elapsed = useRef(0)
  const swipe = useRef<[number, number] | null>(null)
  const [running, setRunning] = useState(false)
  const [view, setView] = useState({ score: 0, best: 0, dead: false })
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!running && ctx.current) drawSnake(ctx.current, state.current) }, [running, ctx, view])
  useLoop(dt => {
    elapsed.current += dt
    const interval = Math.max(0.06, 0.13 - state.current.score * 0.003) // speeds up as you grow
    while (elapsed.current >= interval && !state.current.dead) {
      elapsed.current -= interval
      const before = state.current.score
      state.current = stepSnake(state.current, want.current)
      if (state.current.dead || state.current.score !== before) {
        const { score, dead } = state.current
        setView(v => ({ score, dead, best: Math.max(v.best, score) }))
        if (dead) setRunning(false)
      }
    }
    if (ctx.current) drawSnake(ctx.current, state.current)
  }, running)

  const start = () => { state.current = newSnake(); want.current = 'right'; elapsed.current = 0; setView(v => ({ ...v, score: 0, dead: false })); setRunning(true); root.current?.focus() }
  const turn = (direction: Direction) => { want.current = direction; if (!running) start() }
  const onKey = (event: KeyboardEvent) => { const direction = KEY_DIRECTIONS[event.key]; if (direction) { event.preventDefault(); turn(direction) } }
  const onUp = (event: PointerEvent) => {
    const from = swipe.current; swipe.current = null
    if (!from) return
    const dx = event.clientX - from[0], dy = event.clientY - from[1]
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'))
  }
  return <div className="game-stage" ref={root} tabIndex={0} onKeyDown={onKey}>
    <div className="game-score"><span data-on={running} data-tone="green">Score <b>{view.score}</b></span><span data-tone="amber">Best <b>{view.best}</b></span></div>
    <canvas ref={ref} className="game-canvas" role="img" aria-label="Snake. Swipe or use the arrow keys." onPointerDown={e => { swipe.current = [e.clientX, e.clientY] }} onPointerUp={onUp} />
    <p className="game-status" aria-live="polite">{view.dead ? `Crashed with ${view.score}` : running ? 'Swipe or use arrow keys / WASD' : 'Eat, grow, do not hit the walls or yourself.'}</p>
    <button type="button" className="app-btn app-btn--primary" disabled={running} onClick={start}>{view.dead ? 'Try again' : 'Start'}</button>
  </div>
}
