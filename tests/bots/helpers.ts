import type { BotDifficulty, BotPersonality, GameMode } from '@/engine/index.ts';
import { decideFor, type BotDecision, type BotProfile } from '@/bots/index.ts';
import { TestGame, testId } from '../engine/harness';

/** A TestGame whose seats are all bots (test-only: the seats are marked on the state directly). */
export function botTable(
  names: string[] = ['Asha', 'Bilal', 'Chitra', 'Dev'],
  profile: BotProfile = { difficulty: 'normal', personality: 'investor' },
  options: { mode?: GameMode; config?: unknown; profiles?: Record<string, BotProfile> } = {},
): TestGame {
  const g = new TestGame(names, { mode: options.mode, config: options.config });
  markBots(g, names, profile, options.profiles);
  return g;
}

export function markBots(g: TestGame, names: string[], profile: BotProfile, profiles: Record<string, BotProfile> = {}): void {
  g.state = { ...g.state, players: g.state.players.map((p) => (names.includes(p.name) ? { ...p, bot: profiles[p.name] ?? profile } : p)) };
}

export function decideAs(g: TestGame, name: string, profile?: Partial<BotProfile>, extra: { exclude?: string[]; actionsThisTurn?: number } = {}): BotDecision {
  const player = g.player(name);
  const p: BotProfile = { difficulty: (profile?.difficulty ?? player.bot?.difficulty ?? 'normal') as BotDifficulty, personality: (profile?.personality ?? player.bot?.personality ?? 'investor') as BotPersonality };
  return decideFor(g.state, { id: player.id, profile: p }, { nowMs: g.nowMs, debug: true, exclude: extra.exclude ? { [player.id]: extra.exclude } : undefined, actionsThisTurn: { [player.id]: extra.actionsThisTurn ?? 0 } });
}

/** Sets a player's cash (test setup only), with a matching ledger row so the harness's money invariant still holds. */
export function setCash(g: TestGame, name: string, balance: number): void {
  const player = g.player(name);
  const diff = balance - player.balance;
  if (diff !== 0) {
    g.ledger.push({
      id: testId(),
      actionId: testId(),
      type: 'STARTING_FUNDS',
      fromPlayerId: diff < 0 ? player.id : null,
      toPlayerId: diff > 0 ? player.id : null,
      amount: Math.abs(diff),
      propertyKey: null,
      memo: 'test setup',
      reversesTransactionId: null,
      createdAt: new Date(g.nowMs).toISOString(),
    });
  }
  g.state = { ...g.state, players: g.state.players.map((p) => (p.name === name ? { ...p, balance } : p)) };
}
