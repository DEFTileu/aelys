/** Exact fixed-point representation of finance amounts (four fractional digits). */
export function decimalToUnits(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,4}))?$/.exec(value)
  if (!match) throw new Error('Invalid decimal money amount')
  const units = BigInt(match[2]!) * 10000n + BigInt((match[3] ?? '').padEnd(4, '0'))
  return match[1] === '-' ? -units : units
}

export function sumDecimals(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + decimalToUnits(value), 0n)
}

export function formatMoney(units: bigint): string {
  const sign = units < 0n ? '-' : ''
  const magnitude = units < 0n ? -units : units
  const fraction = (magnitude % 10000n).toString().padStart(4, '0').replace(/0{1,2}$/, '')
  return `${sign}${magnitude / 10000n}.${fraction}`
}
