import type { ReactNode } from 'react'
import '../apps.css'

/** Phone frame: no card, the game stage uses the full width. */
export function GamesMobile({ children }: { children: ReactNode }) {
  return <section className="games games--mobile" aria-label="Game">{children}</section>
}
