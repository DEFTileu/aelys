import { Mail, Send, Smartphone } from '../../../icons'

export interface RoundPreviewProps {
  /** Rendered diameter in px; the 466-px device screen is scaled down to it. */
  size: number
  /** Only the lines the finder will see: leave a contact out to hide it. */
  name?: string | null
  phone?: string
  telegram?: string
  email?: string
  message: string
  qr: 'telegram' | 'phone' | 'none'
}

const N = 25
const FINDERS = [[0, 0], [N - 7, 0], [0, N - 7]]

// shortcut: a look-alike, not a scannable code (no QR encoder in the web app); the device draws the real one. Upgrade when an encoder ships.
function qrPath(seed: string): string {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  let d = ''
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let on: boolean
    const f = FINDERS.find(([fx, fy]) => x >= fx! && x < fx! + 7 && y >= fy! && y < fy! + 7)
    if (f) { const dx = x - f[0]!, dy = y - f[1]!; on = dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) }
    else { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; on = (h & 1) === 1 }
    if (on) d += `M${x} ${y}h1v1h-1z`
  }
  return d
}

/** What a finder sees on Aelys's round screen while lost mode is on, as the design's live preview. */
export function RoundPreview({ size, name, phone, telegram, email, message, qr }: RoundPreviewProps) {
  const target = qr === 'telegram' ? telegram : qr === 'phone' ? phone : undefined
  const lines = [[Smartphone, phone], [Send, telegram], [Mail, email]] as const
  return <div className="dv-mini" style={{ width: size, height: size }} aria-hidden="true" data-testid="round-preview">
    <div className="dv-screen" style={{ transform: `scale(${size / 466})` }}>
      <div className="dv-ring" />
      <div className="dv-face">
        <div className="dv-eyes"><i /><i /></div>
        <div className="dv-h2">This Aelys is lost</div>
        <div className="dv-mt">If found, please contact</div>
        <div className="dv-who">
          {target && <svg viewBox="-2 -2 29 29" width="104" height="104" role="img" aria-label="QR code with the owner contact link"><path d={qrPath(target)} fill="#000" /></svg>}
          <div className="dv-contact">
            {name && <div className="dv-name">{name}</div>}
            {lines.map(([Icon, value], i) => value ? <div key={i} className="dv-line"><Icon size={16} />{value}</div> : null)}
          </div>
        </div>
        {message && <div className="dv-mt dv-msg">“{message}”</div>}
      </div>
    </div>
  </div>
}
