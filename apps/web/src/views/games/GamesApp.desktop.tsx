import type { ReactNode } from 'react'
import '../apps.css'

export function GamesDesktop({ children }: { children: ReactNode }) {
  return <section className="app-panel games" aria-label="Game">{children}</section>
}
