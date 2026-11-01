/** Safe calculator: no eval. Supports + - * / ^ ( ), postfix %, "x% of y", unit and temperature conversion. */
const UNITS: Record<string, readonly [string, number]> = {
  mm: ['len', 0.001], cm: ['len', 0.01], m: ['len', 1], km: ['len', 1000], in: ['len', 0.0254], ft: ['len', 0.3048], yd: ['len', 0.9144], mi: ['len', 1609.344],
  g: ['mass', 1], kg: ['mass', 1000], lb: ['mass', 453.59237], oz: ['mass', 28.349523125],
  ml: ['vol', 0.001], l: ['vol', 1], gal: ['vol', 3.785411784], cup: ['vol', 0.2365882365],
  s: ['time', 1], min: ['time', 60], h: ['time', 3600], d: ['time', 86400],
}
export class CalcError extends Error {}

function parse(input: string): number {
  const src = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '')
  let i = 0
  const peek = () => src[i]
  const primary = (): number => {
    if (peek() === '(') { i++; const v = sum(); if (peek() !== ')') throw new CalcError('Missing )'); i++; return v }
    if (peek() === '-') { i++; return -primary() }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i))
    if (!m) throw new CalcError('Expected a number')
    i += m[0].length
    return Number(m[0])
  }
  const post = (): number => { let v = primary(); while (peek() === '%') { i++; v /= 100 } return v }
  const pow = (): number => { const b = post(); if (peek() === '^') { i++; return b ** pow() } return b }
  const prod = (): number => {
    let v = pow()
    while (peek() === '*' || peek() === '/') {
      const op = src[i++]; const r = pow()
      if (op === '/' && r === 0) throw new CalcError('Cannot divide by zero')
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const sum = (): number => { let v = prod(); while (peek() === '+' || peek() === '-') { const op = src[i++]; v = op === '+' ? v + prod() : v - prod() } return v }
  const result = sum()
  if (i < src.length) throw new CalcError(`Unexpected ${src[i]}`)
  return result
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) throw new CalcError('Result is too large')
  return String(Number(n.toPrecision(12)))
}
function temp(v: number, from: string, to: string): string {
  if (from === to) throw new CalcError('Those units do not convert')
  return `${fmt(from === 'c' ? v * 9 / 5 + 32 : (v - 32) * 5 / 9)} °${to.toUpperCase()}`
}

export function calculate(input: string): string {
  const text = input.trim().toLowerCase()
  if (!text) throw new CalcError('Type something to calculate')
  const tc = /^(-?[\d.]+)\s*°?([cf])\s+(?:to|in)\s+°?([cf])$/.exec(text)
  if (tc) return temp(Number(tc[1]), tc[2]!, tc[3]!)
  const conv = /^(-?[\d.]+)\s*([a-z]+)\s+(?:to|in)\s+([a-z]+)$/.exec(text)
  if (conv) {
    const from = UNITS[conv[2]!], to = UNITS[conv[3]!]
    if (!from || !to || from[0] !== to[0]) throw new CalcError('Those units do not convert')
    return `${fmt(Number(conv[1]) * from[1] / to[1])} ${conv[3]}`
  }
  const pct = /^([\d.]+)\s*%\s*of\s*(.+)$/.exec(text)
  if (pct) return fmt(Number(pct[1]) / 100 * parse(pct[2]!))
  return fmt(parse(text))
}
