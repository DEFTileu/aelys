import { expect, it } from 'vitest'
import { calculate, CalcError } from '../lib/calc'

it('evaluates arithmetic with precedence, powers and percent', () => {
  expect(calculate('24 × 12')).toBe('288')
  expect(calculate('2+3*4')).toBe('14')
  expect(calculate('2^3^2')).toBe('512')
  expect(calculate('(1+2)*3')).toBe('9')
  expect(calculate('50%')).toBe('0.5')
  expect(calculate('15% of 80')).toBe('12')
  expect(calculate('0.1+0.2')).toBe('0.3')
})
it('converts units and temperatures', () => {
  expect(calculate('5 km to mi')).toBe('3.10685596119 mi')
  expect(calculate('100 c to f')).toBe('212 °F')
  expect(calculate('32f to c')).toBe('0 °C')
})
it('rejects bad input without eval', () => {
  for (const bad of ['', '1/0', '2+', 'alert(1)', '5 km to kg']) expect(() => calculate(bad)).toThrow(CalcError)
})
