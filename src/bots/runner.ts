import { auctionOpensAt, type GameAction, type GameState, type PlayerState } from '../engine/index.ts';
import { observe } from './observation.ts';
import { decide } from './policy.ts';
import { seatSeed } from './random.ts';
import type { BotDecision, BotProfile } from './types.ts';

/**
 * Which bot acts next, and what it does. Shared by every place bots play — the server (online games), the
 * device (local solo games) and the simulations — so a bot behaves the same everywhere.
 *
 * Only seats the state marks as bots (PlayerState.bot) are ever played, and each is decided from its own
 * observation (observation.ts). The caller applies the action through the engine, exactly as for a person.
 */

export interface BotSeatRef {
  id: string;
  profile: BotProfile;
}

/** The bot seats still playing, in seat (turn) order. */
export function activeBots(state: GameState): BotSeatRef[] {
  return state.players
    .filter((p): p is PlayerState & { bot: BotProfile } => p.status === 'ACTIVE' && !!p.bot)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({ id: p.id, profile: p.bot }));
}

export interface BotMove {
  botId: string;
  action: GameAction;
  decision: BotDecision;
}

export interface NextMoveOptions {
  nowMs: number;
  /** Per bot: actions the server refused for the current state, not to be proposed again for it. */
  exclude?: Readonly<Record<string, readonly string[]>>;
  /** Per bot: actions already taken this turn (bounds optional moves). */
  actionsThisTurn?: Readonly<Record<string, number>>;
  debug?: boolean;
}

/**
 * The first bot, in turn order starting with the one whose turn it is, that has an action to take now. Null
 * when no bot has anything to do (a person is to move, a timer is running, or the game is not running).
 */
export function nextBotMove(state: GameState, options: NextMoveOptions): BotMove | null {
  if (state.status !== 'ACTIVE') return null;
  const bots = activeBots(state);
  if (bots.length === 0) return null;
  const turnIndex = bots.findIndex((b) => b.id === state.turn.playerId);
  const ordered = turnIndex > 0 ? [...bots.slice(turnIndex), ...bots.slice(0, turnIndex)] : bots;
  for (const bot of ordered) {
    const decision = decideFor(state, bot, options);
    if (decision.action) return { botId: bot.id, action: decision.action, decision };
  }
  return null;
}

/** One bot's decision on the current state. */
export function decideFor(state: GameState, bot: BotSeatRef, options: NextMoveOptions): BotDecision {
  const obs = observe(state, bot.id, options.nowMs);
  return decide(obs, {
    profile: bot.profile,
    seed: seatSeed(state.id, bot.id),
    actionsThisTurn: options.actionsThisTurn?.[bot.id] ?? 0,
    exclude: options.exclude?.[bot.id],
    debug: options.debug,
  });
}

/**
 * The next instant at which a bot may have something to do purely because time passed, or null. Today that
 * is a resale auction's "get ready" countdown: bots must wait for it, and nothing else happens when it ends,
 * so a runner that found nothing to do has to wake up then (the device's timer, the server's deferred run).
 */
export function nextBotWakeAt(state: GameState, nowMs: number): number | null {
  if (state.status !== 'ACTIVE') return null;
  const auction = state.auction;
  if (!auction || auction.status !== 'OPEN') return null;
  const opensAt = auctionOpensAt(auction);
  if (opensAt <= nowMs) return null;
  const bidders = activeBots(state).filter((b) => auction.participantIds.includes(b.id) && !auction.passedIds.includes(b.id) && auction.resale?.sellerId !== b.id);
  return bidders.length > 0 ? opensAt : null;
}

/** Whether any bot could need to act in this state (cheap; no decision is computed). */
export function botsMayAct(state: GameState): boolean {
  return state.status === 'ACTIVE' && activeBots(state).length > 0;
}

