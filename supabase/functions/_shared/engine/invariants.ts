import { PROPERTY_KEYS } from './businessBoard.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import type { GameState, TransactionRecord } from './types.ts';

/**
 * Money invariant: every player's balance equals the sum of their incoming
 * minus outgoing transactions (starting cash is itself a STARTING_FUNDS
 * transaction). Returns a list of human-readable violations (empty = OK).
 */
export function ledgerViolations(state: Pick<GameState, 'players'>, ledger: readonly TransactionRecord[]): string[] {
  const net = new Map<string, number>();
  for (const tx of ledger) {
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) return [`Transaction ${tx.id} has invalid amount ${tx.amount}`];
    if (tx.fromPlayerId) net.set(tx.fromPlayerId, (net.get(tx.fromPlayerId) ?? 0) - tx.amount);
    if (tx.toPlayerId) net.set(tx.toPlayerId, (net.get(tx.toPlayerId) ?? 0) + tx.amount);
  }
  const problems: string[] = [];
  for (const p of state.players) {
    const expected = net.get(p.id) ?? 0;
    if (expected !== p.balance) problems.push(`${p.name}: ledger says ${expected}, balance is ${p.balance}`);
    if (p.balance < 0) problems.push(`${p.name}: negative balance ${p.balance}`);
  }
  return problems;
}

/** Structural invariants on property state. */
export function propertyViolations(state: Pick<GameState, 'players' | 'properties'>): string[] {
  const ids = new Set(state.players.map((p) => p.id));
  const problems: string[] = [];
  for (const key of PROPERTY_KEYS) {
    const prop = state.properties[key];
    if (!prop) {
      problems.push(`${key}: missing`);
      continue;
    }
    if (prop.ownerId !== null && !ids.has(prop.ownerId)) problems.push(`${key}: unknown owner`);
    if (prop.ownerId === null && (prop.houses > 0 || prop.hotel || prop.mortgaged)) problems.push(`${key}: bank-owned but developed`);
    if (prop.houses < 0 || prop.houses > 3) problems.push(`${key}: invalid house count ${prop.houses}`);
    if (prop.hotel && prop.houses !== 0) problems.push(`${key}: hotel with houses`);
    if (prop.mortgaged && (prop.houses > 0 || prop.hotel)) problems.push(`${key}: mortgaged with buildings`);
  }
  return problems;
}

/** Structural invariants on player turn state (Jail / Rest House). */
export function playerViolations(state: Pick<GameState, 'players'>): string[] {
  const problems: string[] = [];
  for (const p of state.players) {
    if (p.inJail !== p.jailTurnsLeft > 0) problems.push(`${p.name}: inJail=${p.inJail} but jailTurnsLeft=${p.jailTurnsLeft}`);
    if (p.jailTurnsLeft < 0 || p.jailTurnsLeft > RULES.jail.maxTurns) problems.push(`${p.name}: invalid jailTurnsLeft ${p.jailTurnsLeft}`);
    if (p.skipTurns < 0) problems.push(`${p.name}: negative skipTurns`);
    if (p.status !== 'ACTIVE' && (p.inJail || p.skipTurns > 0)) problems.push(`${p.name}: out of the game but still in Jail / resting`);
  }
  return problems;
}
