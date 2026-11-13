const enc = new TextEncoder()
export const byteLength = (v: string) => enc.encode(v).length

/** The board's limits are bytes, not characters: cut at a whole character that still fits. */
export function clampBytes(v: string, max: number): string {
  if (byteLength(v) <= max) return v
  let out = ''
  for (const ch of v) { if (byteLength(out + ch) > max) break; out += ch }
  return out
}
