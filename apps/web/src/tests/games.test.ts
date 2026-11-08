import { expect, it } from 'vitest'
import { C4_COLS, C4_ROWS, canMove, connectFourLine, connectFourResult, dropDisc, shuffle, slide, ticTacToeLine, ticTacToeResult, type C4Board } from '../lib/games'

it('detects tic-tac-toe wins, draws and ongoing games', () => {
  expect(ticTacToeResult(['X', 'X', 'X', null, 'O', 'O', null, null, null])).toBe('X')
  expect(ticTacToeResult(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'])).toBe('draw')
  expect(ticTacToeResult(Array(9).fill(null))).toBeNull()
})

it('drops connect-four discs to the bottom and rejects full or invalid columns', () => {
  let board: C4Board = Array(C4_COLS * C4_ROWS).fill(0)
  board = dropDisc(board, 3, 1)!
  expect(board[(C4_ROWS - 1) * C4_COLS + 3]).toBe(1)
  for (let i = 0; i < C4_ROWS - 1; i++) board = dropDisc(board, 3, 2)!
  expect(dropDisc(board, 3, 1)).toBeNull()
  expect(dropDisc(board, 9, 1)).toBeNull()
})

it('finds horizontal, vertical and diagonal connect-four wins', () => {
  const empty: C4Board = Array(C4_COLS * C4_ROWS).fill(0)
  let h = empty; for (let c = 0; c < 4; c++) h = dropDisc(h, c, 1)!
  expect(connectFourResult(h)).toBe(1)
  let v = empty; for (let i = 0; i < 4; i++) v = dropDisc(v, 0, 2)!
  expect(connectFourResult(v)).toBe(2)
  const d = empty.slice(); for (let i = 0; i < 4; i++) d[(C4_ROWS - 1 - i) * C4_COLS + i] = 1
  expect(connectFourResult(d)).toBe(1)
  expect(connectFourResult(empty)).toBeNull()
})

it('slides and merges 2048 tiles once per move', () => {
  const result = slide([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'left')
  expect(result.grid[0]).toEqual([4, 4, 0, 0]); expect(result.gained).toBe(8); expect(result.moved).toBe(true)
  expect(slide([[2, 0], [0, 0]], 'left').moved).toBe(false)
  expect(slide([[0, 0], [2, 0]], 'up').grid).toEqual([[2, 0], [0, 0]])
  expect(slide([[0, 2], [0, 0]], 'down').grid).toEqual([[0, 0], [0, 2]])
  expect(canMove([[2, 4], [4, 2]])).toBe(false)
})

it('shuffles without losing items', () => {
  expect(shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5])
})

it('reports the winning cells for highlighting', () => {
  expect(ticTacToeLine(['X', 'X', 'X', null, 'O', 'O', null, null, null])).toEqual([0, 1, 2])
  let board: C4Board = Array(C4_COLS * C4_ROWS).fill(0)
  for (let c = 0; c < 4; c++) board = dropDisc(board, c, 1)!
  expect(connectFourLine(board)).toEqual([35, 36, 37, 38])
})
