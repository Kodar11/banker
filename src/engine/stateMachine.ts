import type { GameStatus, TurnPhase } from './types.ts';

/**
 * Explicit turn-phase transition table.
 *
 * AWAITING_ROLL → MOVING → RESOLVING → (AWAITING_DECISION | AWAITING_PAYMENT | AWAITING_CARD | TURN_COMPLETE)
 * AWAITING_DECISION → TRANSACTION (buy) | AUCTION (decline) | TURN_COMPLETE (decline, no auction)
 * AUCTION → TRANSACTION (winner pays) | TURN_COMPLETE (unsold)
 * TRANSACTION → TURN_COMPLETE | AWAITING_PAYMENT (card: pay after other effects)
 *             | RESOLVING (loan interest paid at Start → now resolve the square landed on)
 * TURN_COMPLETE → AWAITING_ROLL (next player)
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  AWAITING_ROLL: ['MOVING'],
  MOVING: ['RESOLVING'],
  RESOLVING: ['AWAITING_DECISION', 'AWAITING_PAYMENT', 'AWAITING_CARD', 'TURN_COMPLETE', 'MOVING', 'TRANSACTION'],
  AWAITING_DECISION: ['TRANSACTION', 'AUCTION', 'TURN_COMPLETE'],
  AWAITING_PAYMENT: ['TRANSACTION', 'TURN_COMPLETE'],
  AWAITING_CARD: ['TRANSACTION', 'AWAITING_PAYMENT', 'TURN_COMPLETE'],
  AUCTION: ['TRANSACTION', 'TURN_COMPLETE'],
  TRANSACTION: ['TURN_COMPLETE', 'AWAITING_PAYMENT', 'MOVING', 'RESOLVING'],
  TURN_COMPLETE: ['AWAITING_ROLL'],
};

export const GAME_STATUS_TRANSITIONS: Readonly<Record<GameStatus, readonly GameStatus[]>> = {
  // FINISHED straight from the lobby: everyone left before the game started.
  WAITING: ['ACTIVE', 'FINISHED'],
  ACTIVE: ['PAUSED', 'FINISHED'],
  PAUSED: ['ACTIVE', 'FINISHED'],
  FINISHED: [],
};

/** Phases a turn can rest in between actions (everything else is transient). */
export const RESTING_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  'AWAITING_ROLL',
  'AWAITING_DECISION',
  'AWAITING_PAYMENT',
  'AWAITING_CARD',
  'AUCTION',
  'TURN_COMPLETE',
]);

export function canTransition(from: TurnPhase, to: TurnPhase): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

export function canTransitionStatus(from: GameStatus, to: GameStatus): boolean {
  return GAME_STATUS_TRANSITIONS[from].includes(to);
}
