/** Pure rules for the offline Games app. No I/O, no storage. */

export type GameId = 'hockey' | 'duel' | 'c4' | 'ttt' | 'snake' | '2048' | 'memory'

export type Mark = 'X' | 'O'

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const

/** The three winning cell indexes of a 3x3 board, or null. */
export function ticTacToeLine(board: readonly (Mark | null)[]): readonly number[] | null {
  return LINES.find(([a, b, c]) => board[a!] && board[a!] === board[b!] && board[a!] === board[c!]) ?? null
}

/** Returns the winning mark of a 3x3 board, 'draw' when full, or null while play continues. */
export function ticTacToeResult(board: readonly (Mark | null)[]): Mark | 'draw' | null {
  const line = ticTacToeLine(board)
  return line ? board[line[0]!]! : board.every(Boolean) ? 'draw' : null
}

export const C4_COLS = 7
export const C4_ROWS = 6
export type Disc = 1 | 2
export type C4Board = readonly (Disc | 0)[] // row-major, row 0 on top

/** Drops a disc into a column. Returns null when the column is full or out of range. */
export function dropDisc(board: C4Board, col: number, disc: Disc): C4Board | null {
  if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) return null
  for (let row = C4_ROWS - 1; row >= 0; row--) {
    const index = row * C4_COLS + col
    if (!board[index]) { const next = board.slice(); next[index] = disc; return next }
  }
  return null
}

/** The four winning cell indexes of a connect-four board, or null. */
export function connectFourLine(board: C4Board): readonly number[] | null {
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= C4_ROWS || c >= C4_COLS ? 0 : board[r * C4_COLS + c]!)
  for (let r = 0; r < C4_ROWS; r++) for (let c = 0; c < C4_COLS; c++) {
    const disc = at(r, c)
    if (!disc) continue
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const)
      if ([1, 2, 3].every(step => at(r + dr * step, c + dc * step) === disc)) return [0, 1, 2, 3].map(step => (r + dr * step) * C4_COLS + c + dc * step)
  }
  return null
}

export function connectFourResult(board: C4Board): Disc | 'draw' | null {
  const line = connectFourLine(board)
  return line ? board[line[0]!] as Disc : board.every(Boolean) ? 'draw' : null
}

export type Grid = readonly (readonly number[])[]
export type Direction = 'left' | 'right' | 'up' | 'down'

function slideRowLeft(row: readonly number[]): { row: number[]; gained: number } {
  const tiles = row.filter(Boolean), out: number[] = []
  let gained = 0
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === tiles[i + 1]) { out.push(tiles[i]! * 2); gained += tiles[i]! * 2; i++ } else out.push(tiles[i]!)
  }
  while (out.length < row.length) out.push(0)
  return { row: out, gained }
}

/** Slides a 2048 grid. `moved` is false when nothing changed (so no tile should spawn). */
export function slide(grid: Grid, direction: Direction): { grid: number[][]; gained: number; moved: boolean } {
  const n = grid.length
  const read = (i: number, j: number) => direction === 'left' ? grid[i]![j]! : direction === 'right' ? grid[i]![n - 1 - j]! : direction === 'up' ? grid[j]![i]! : grid[n - 1 - j]![i]!
  const next = grid.map(row => row.slice())
  let gained = 0
  for (let i = 0; i < n; i++) {
    const result = slideRowLeft(Array.from({ length: n }, (_, j) => read(i, j)))
    gained += result.gained
    result.row.forEach((value, j) => {
      if (direction === 'left') next[i]![j] = value
      else if (direction === 'right') next[i]![n - 1 - j] = value
      else if (direction === 'up') next[j]![i] = value
      else next[n - 1 - j]![i] = value
    })
  }
  return { grid: next, gained, moved: next.some((row, i) => row.some((v, j) => v !== grid[i]![j])) }
}

export const canMove = (grid: Grid) => (['left', 'right', 'up', 'down'] as const).some(d => slide(grid, d).moved)

/** Fisher-Yates with an injectable random source so tests are deterministic. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!] }
  return out
}
