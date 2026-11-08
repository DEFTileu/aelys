import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { C4_COLS, C4_ROWS, canMove, connectFourLine, connectFourResult, dropDisc, shuffle, slide, ticTacToeLine, ticTacToeResult, type C4Board, type Direction, type Disc, type Grid, type Mark } from '../../lib/games'

/** Board and puzzle games shared by the desktop and mobile Games screens. Pure client state: nothing is sent, stored or shared. */

export function Score({ items }: { items: readonly { label: string; value: number; tone: string; on?: boolean }[] }) {
  return <div className="game-score">{items.map(item => <span key={item.label} data-tone={item.tone} data-on={item.on}>{item.label} <b>{item.value}</b></span>)}</div>
}

export function TicTacToe() {
  const [board, setBoard] = useState<(Mark | null)[]>(Array(9).fill(null))
  const [turn, setTurn] = useState<Mark>('X')
  const [score, setScore] = useState({ X: 0, O: 0 })
  const result = ticTacToeResult(board), line = ticTacToeLine(board)
  const play = (index: number) => {
    if (result || board[index]) return
    const next = board.slice(); next[index] = turn
    setBoard(next); setTurn(turn === 'X' ? 'O' : 'X')
    const done = ticTacToeResult(next)
    if (done && done !== 'draw') setScore(s => ({ ...s, [done]: s[done] + 1 }))
  }
  return <div className="game-stage">
    <Score items={[{ label: 'X', value: score.X, tone: 'purple', on: !result && turn === 'X' }, { label: 'O', value: score.O, tone: 'amber', on: !result && turn === 'O' }]} />
    <div className="game-ttt" role="grid" aria-label="Tic-tac-toe board">{board.map((cell, index) => <button type="button" key={index} className="game-cell" data-mark={cell ?? undefined} data-win={line?.includes(index) || undefined} aria-label={`Cell ${index + 1}${cell ? `, ${cell}` : ''}`} onClick={() => play(index)}>{cell}</button>)}</div>
    <p className="game-status" aria-live="polite">{result === 'draw' ? 'Draw' : result ? `${result} wins` : `${turn} to move`}</p>
    <button type="button" className="app-btn app-btn--primary" onClick={() => { setBoard(Array(9).fill(null)); setTurn('X') }}>New round</button>
  </div>
}

const emptyC4 = (): C4Board => Array(C4_COLS * C4_ROWS).fill(0)
export function ConnectFour() {
  const [board, setBoard] = useState<C4Board>(emptyC4)
  const [turn, setTurn] = useState<Disc>(1)
  const [last, setLast] = useState(-1)
  const [score, setScore] = useState({ 1: 0, 2: 0 })
  const result = connectFourResult(board), line = connectFourLine(board)
  const name = (d: Disc) => d === 1 ? 'Red' : 'Yellow'
  const play = (col: number) => {
    if (result) return
    const next = dropDisc(board, col, turn)
    if (!next) return
    setLast(next.findIndex((value, index) => value !== board[index]))
    setBoard(next); setTurn(turn === 1 ? 2 : 1)
    const done = connectFourResult(next)
    if (done && done !== 'draw') setScore(s => ({ ...s, [done]: s[done] + 1 }))
  }
  return <div className="game-stage">
    <Score items={[{ label: 'Red', value: score[1], tone: 'red', on: !result && turn === 1 }, { label: 'Yellow', value: score[2], tone: 'amber', on: !result && turn === 2 }]} />
    <div className="game-c4" role="group" aria-label="Connect four board">{Array.from({ length: C4_COLS }, (_, col) => <button type="button" key={col} className="game-col" disabled={!!result || !!board[col]} aria-label={`Drop in column ${col + 1}`} onClick={() => play(col)}>
      {Array.from({ length: C4_ROWS }, (_, row) => { const index = row * C4_COLS + col; return <i key={row} data-disc={board[index]} data-new={index === last || undefined} data-win={line?.includes(index) || undefined} style={{ '--row': row } as React.CSSProperties} /> })}
    </button>)}</div>
    <p className="game-status" aria-live="polite">{result === 'draw' ? 'Draw' : result ? `${name(result)} wins` : `${name(turn)} to move`}</p>
    <button type="button" className="app-btn app-btn--primary" onClick={() => { setBoard(emptyC4()); setTurn(1); setLast(-1) }}>New round</button>
  </div>
}

type DuelState = 'idle' | 'wait' | 'go' | 'done'
export function ReactionDuel() {
  const [state, setState] = useState<DuelState>('idle')
  const [message, setMessage] = useState('Fingers ready. Tap your pad the moment it turns green.')
  const [score, setScore] = useState<[number, number]>([0, 0])
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const live = state === 'wait' || state === 'go'
  const start = () => {
    setState('wait'); setMessage('Wait for it…')
    timer.current = window.setTimeout(() => { setState('go'); setMessage('TAP!') }, 1500 + Math.random() * 2500)
  }
  const tap = (player: 0 | 1) => {
    if (!live) return
    window.clearTimeout(timer.current)
    const winner = state === 'go' ? player : (1 - player) as 0 | 1 // tapping early forfeits the round
    setScore(s => s.map((v, i) => i === winner ? v + 1 : v) as [number, number])
    setMessage(state === 'go' ? `Player ${player + 1} wins` : `Player ${player + 1} jumped the gun`)
    setState('done')
  }
  return <div className="game-stage game-stage--duel" data-state={state}>
    <button type="button" className="game-pad game-pad--flip" data-tone="amber" onClick={() => tap(0)}><span>Player 1</span><b>{score[0]}</b></button>
    <p className="game-status game-status--big" aria-live="polite">{message}</p>
    <button type="button" className="game-pad" data-tone="purple" onClick={() => tap(1)}><span>Player 2</span><b>{score[1]}</b></button>
    <button type="button" className="app-btn app-btn--primary" disabled={live} onClick={start}>{state === 'done' ? 'Next round' : 'Start'}</button>
  </div>
}

const SIZE = 4
const emptyGrid = (): number[][] => Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
function spawn(grid: Grid): number[][] {
  const next = grid.map(row => row.slice())
  const free = next.flatMap((row, r) => row.map((v, c) => v ? null : [r, c] as const)).filter((cell): cell is readonly [number, number] => !!cell)
  if (!free.length) return next
  const [r, c] = free[Math.floor(Math.random() * free.length)]!
  next[r]![c] = Math.random() < 0.9 ? 2 : 4
  return next
}
const fresh = () => spawn(spawn(emptyGrid()))
const KEYS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

export function Game2048() {
  const [grid, setGrid] = useState<number[][]>(fresh)
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(0)
  const swipe = useRef<[number, number] | null>(null)
  const over = !canMove(grid)
  const move = (direction: Direction) => {
    const result = slide(grid, direction)
    if (!result.moved) return
    setGrid(spawn(result.grid)); setScore(score + result.gained); setBest(Math.max(best, score + result.gained))
  }
  const onKey = (event: KeyboardEvent) => { const direction = KEYS[event.key]; if (direction) { event.preventDefault(); move(direction) } }
  const onUp = (event: PointerEvent) => {
    const from = swipe.current; swipe.current = null
    if (!from) return
    const dx = event.clientX - from[0], dy = event.clientY - from[1]
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return
    move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'))
  }
  return <div className="game-stage" onKeyDown={onKey}>
    <Score items={[{ label: 'Score', value: score, tone: 'purple' }, { label: 'Best', value: best, tone: 'amber' }]} />
    <div className="game-2048" tabIndex={0} aria-label="2048 board. Swipe or use the arrow keys." onPointerDown={e => { swipe.current = [e.clientX, e.clientY] }} onPointerUp={onUp}>{grid.flat().map((v, i) => <span key={i} data-v={v || undefined}>{v || ''}</span>)}</div>
    <p className="game-status" aria-live="polite">{over ? 'No moves left' : 'Swipe or use arrow keys'}</p>
    <button type="button" className="app-btn app-btn--primary" onClick={() => { setGrid(fresh()); setScore(0) }}>New game</button>
  </div>
}

const FACES = ['🌙', '⭐', '🔥', '🌊', '🍀', '🎲', '🦊', '🍋']
const deal = () => shuffle([...FACES, ...FACES])
export function Memory() {
  const [cards, setCards] = useState(deal)
  const [open, setOpen] = useState<number[]>([])
  const [found, setFound] = useState<ReadonlySet<number>>(new Set())
  const [moves, setMoves] = useState(0)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const flip = (index: number) => {
    if (open.length === 2 || open.includes(index) || found.has(index)) return
    const next = [...open, index]
    setOpen(next)
    if (next.length < 2) return
    setMoves(moves + 1)
    const [a, b] = next as [number, number]
    timer.current = window.setTimeout(() => {
      if (cards[a] === cards[b]) setFound(new Set([...found, a, b]))
      setOpen([])
    }, 750)
  }
  const reset = () => { window.clearTimeout(timer.current); setCards(deal()); setOpen([]); setFound(new Set()); setMoves(0) }
  return <div className="game-stage">
    <Score items={[{ label: 'Moves', value: moves, tone: 'purple' }, { label: 'Pairs', value: found.size / 2, tone: 'green' }]} />
    <div className="game-memory">{cards.map((face, index) => {
      const shown = open.includes(index) || found.has(index)
      return <button type="button" key={index} className="game-card" data-shown={shown} data-found={found.has(index) || undefined} aria-label={shown ? face : 'Hidden card'} onClick={() => flip(index)}><i /><i>{face}</i></button>
    })}</div>
    <p className="game-status" aria-live="polite">{found.size === cards.length ? `All pairs found in ${moves} moves` : 'Find all the pairs'}</p>
    <button type="button" className="app-btn app-btn--primary" onClick={reset}>New game</button>
  </div>
}
