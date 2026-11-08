import type { Direction } from './games'

/** Pure rules for the real-time Games (snake, air hockey). Steps mutate or return small objects so a 60fps loop allocates almost nothing. */

export const SNAKE_N = 18
export type Cell = readonly [number, number]
export type SnakeState = { snake: readonly Cell[]; dir: Direction; food: Cell; score: number; dead: boolean }

const DELTA: Record<Direction, Cell> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
const OPPOSITE: Record<Direction, Direction> = { left: 'right', right: 'left', up: 'down', down: 'up' }
const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

export function placeFood(snake: readonly Cell[], random: () => number = Math.random): Cell {
  const free: Cell[] = []
  for (let y = 0; y < SNAKE_N; y++) for (let x = 0; x < SNAKE_N; x++) if (!snake.some(part => part[0] === x && part[1] === y)) free.push([x, y])
  return free[Math.floor(random() * free.length)] ?? [0, 0]
}

export function newSnake(random: () => number = Math.random): SnakeState {
  const snake: Cell[] = [[9, 9], [8, 9], [7, 9]]
  return { snake, dir: 'right', food: placeFood(snake, random), score: 0, dead: false }
}

/** Advances one tick. Walls and the snake's own body are deadly; reversing straight into yourself is ignored. */
export function stepSnake(state: SnakeState, want: Direction, random: () => number = Math.random): SnakeState {
  if (state.dead) return state
  const dir = want === OPPOSITE[state.dir] ? state.dir : want
  const head: Cell = [state.snake[0]![0] + DELTA[dir][0], state.snake[0]![1] + DELTA[dir][1]]
  const eats = same(head, state.food)
  const body = eats ? state.snake : state.snake.slice(0, -1) // the tail moves out of the way unless we grow
  if (head[0] < 0 || head[1] < 0 || head[0] >= SNAKE_N || head[1] >= SNAKE_N || body.some(part => same(part, head))) return { ...state, dir, dead: true }
  const snake = [head, ...body]
  return { snake, dir, food: eats ? placeFood(snake, random) : state.food, score: state.score + (eats ? 1 : 0), dead: false }
}

export const HW = 300
export const HH = 480
export const PUCK_R = 15
export const MALLET_R = 26
export const GOAL_W = 120
export const WIN_SCORE = 7
const MAX_SPEED = 900

export type Mallet = { x: number; y: number; px: number; py: number }
export type Hockey = { puck: { x: number; y: number; vx: number; vy: number }; mallets: [Mallet, Mallet] }

/** Player 0 defends the top goal, player 1 the bottom. `serve` is the half the puck starts in. */
export const newHockey = (serve: 0 | 1): Hockey => ({
  puck: { x: HW / 2, y: serve === 0 ? HH / 2 - 60 : HH / 2 + 60, vx: 0, vy: 0 },
  mallets: [{ x: HW / 2, y: 70, px: HW / 2, py: 70 }, { x: HW / 2, y: HH - 70, px: HW / 2, py: HH - 70 }],
})

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Keeps a mallet inside its own half of the table. */
export const clampMallet = (player: 0 | 1, x: number, y: number): [number, number] => [
  clamp(x, MALLET_R, HW - MALLET_R),
  player === 0 ? clamp(y, MALLET_R, HH / 2 - MALLET_R) : clamp(y, HH / 2 + MALLET_R, HH - MALLET_R),
]

/** Moves the puck by `dt` seconds in place. Returns the player who scored, if a goal happened. */
export function stepHockey(h: Hockey, dt: number): 0 | 1 | null {
  const p = h.puck
  p.x += p.vx * dt; p.y += p.vy * dt
  const drag = Math.pow(0.45, dt) // roughly 55% speed lost per second
  p.vx *= drag; p.vy *= drag

  if (p.x < PUCK_R) { p.x = PUCK_R; p.vx = Math.abs(p.vx) * 0.95 }
  if (p.x > HW - PUCK_R) { p.x = HW - PUCK_R; p.vx = -Math.abs(p.vx) * 0.95 }
  const inGoal = Math.abs(p.x - HW / 2) < GOAL_W / 2 - PUCK_R * 0.5
  if (p.y < PUCK_R && !inGoal) { p.y = PUCK_R; p.vy = Math.abs(p.vy) * 0.95 }
  if (p.y > HH - PUCK_R && !inGoal) { p.y = HH - PUCK_R; p.vy = -Math.abs(p.vy) * 0.95 }
  if (p.y < -PUCK_R) return 1
  if (p.y > HH + PUCK_R) return 0

  for (const m of h.mallets) {
    const mvx = clamp((m.x - m.px) / dt, -1500, 1500), mvy = clamp((m.y - m.py) / dt, -1500, 1500)
    m.px = m.x; m.py = m.y
    const dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy), reach = PUCK_R + MALLET_R
    if (d >= reach || d === 0) continue
    const nx = dx / d, ny = dy / d
    p.x = m.x + nx * reach; p.y = m.y + ny * reach
    const dot = (p.vx - mvx) * nx + (p.vy - mvy) * ny
    if (dot < 0) { p.vx -= 1.9 * dot * nx; p.vy -= 1.9 * dot * ny }
    const speed = Math.hypot(p.vx, p.vy)
    if (speed > MAX_SPEED) { p.vx *= MAX_SPEED / speed; p.vy *= MAX_SPEED / speed }
  }
  return null
}
