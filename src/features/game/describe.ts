import { getDeed, spaceName, type GameState } from '@/engine/index.ts';
import { formatINR } from '@/utils/currency';

/** One-line description of what the current player is doing, for everyone else. */
export function describeWaiting(state: GameState, name: string): string {
  const { turn } = state;
  const pending = turn.pending;
  switch (turn.phase) {
    case 'AWAITING_ROLL':
      return state.players.find((p) => p.id === turn.playerId)?.inJail ? `${name} is in Jail — pay or stay?` : `${name} is about to roll`;
    case 'AWAITING_DECISION':
      return pending?.kind === 'BUY' ? `${name} is deciding on ${getDeed(pending.propertyKey).name}` : `${name} is deciding`;
    case 'AWAITING_PAYMENT':
      return pending?.kind === 'PAYMENT' ? `${name} owes ${formatINR(pending.amount)} (${pending.label})` : `${name} is paying`;
    case 'AWAITING_CARD':
      return `${name} is reading a card`;
    case 'AUCTION':
      return 'Auction in progress';
    case 'TURN_COMPLETE':
      return `${name} is finishing their turn`;
    default:
      return `${name}'s turn`;
  }
}

const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
export function dieFace(value: number): string {
  return FACES[value - 1] ?? String(value);
}

export function destinationLabel(state: GameState): string | null {
  const to = state.turn.toPosition;
  return to === null ? null : spaceName(to);
}
