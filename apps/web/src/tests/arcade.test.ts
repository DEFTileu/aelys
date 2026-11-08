import { expect, it } from 'vitest'
import { HH, HW, SNAKE_N, newHockey, newSnake, stepHockey, stepSnake } from '../lib/arcade'

it('moves, grows and dies correctly in snake', () => {
  const s = newSnake(() => 0)
  const next = stepSnake(s, 'right', () => 0)
  expect(next.snake[0]).toEqual([10, 9]); expect(next.snake).toHaveLength(3)
  expect(stepSnake(s, 'left').dir).toBe('right') // cannot reverse into itself
  const ate = stepSnake({ ...s, food: [10, 9] }, 'right', () => 0)
  expect(ate.score).toBe(1); expect(ate.snake).toHaveLength(4)
  expect(stepSnake({ ...s, snake: [[SNAKE_N - 1, 0], [SNAKE_N - 2, 0]], dir: 'right' }, 'right').dead).toBe(true)
})

it('scores goals, bounces off walls and hits the puck', () => {
  const goal = newHockey(0); Object.assign(goal.puck, { x: HW / 2, y: -14, vy: -100, vx: 0 })
  expect(stepHockey(goal, 0.016)).toBe(1)
  const wall = newHockey(0); Object.assign(wall.puck, { x: 10, y: 200, vx: -200, vy: 0 })
  stepHockey(wall, 0.016); expect(wall.puck.vx).toBeGreaterThan(0)
  const hit = newHockey(0); hit.mallets[1] = { x: HW / 2, y: HH / 2 + 50, px: HW / 2, py: HH / 2 + 70 }; Object.assign(hit.puck, { x: HW / 2, y: HH / 2 + 20, vx: 0, vy: 0 })
  stepHockey(hit, 0.016); expect(hit.puck.vy).toBeLessThan(-100)
})
