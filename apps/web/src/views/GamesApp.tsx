import { useIsMobile } from '../lib/useIsMobile'
import type { GameId } from '../lib/games'
import { GAME_VIEWS } from './games/catalog'
import { GamesDesktop } from './games/GamesApp.desktop'
import { GamesMobile } from './games/GamesApp.mobile'

/** One game per module: the Apps tile picks the id, the frame depends on the device. */
export default function GamesApp({ id }: { id: GameId }) {
  const Game = GAME_VIEWS[id]
  return useIsMobile() ? <GamesMobile><Game /></GamesMobile> : <GamesDesktop><Game /></GamesDesktop>
}
