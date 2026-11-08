import type { ComponentType } from 'react'
import type { GameId } from '../../lib/games'
import { AirHockey, Snake } from '../Arcade'
import { Game2048, ConnectFour, Memory, ReactionDuel, TicTacToe } from './boards'

export const GAME_VIEWS: Record<GameId, ComponentType> = {
  hockey: AirHockey, duel: ReactionDuel, c4: ConnectFour, ttt: TicTacToe, snake: Snake, '2048': Game2048, memory: Memory,
}
