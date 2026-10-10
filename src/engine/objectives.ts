import { getDeed } from './businessBoard.ts';
import type { Draft } from './draft.ts';
import { formatINR } from './format.ts';
import { configOf } from './gameConfig.ts';
import { defaultedLoans, overdueInstallments } from './intermediateSelectors.ts';
import { economyOf } from './intermediateState.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import { buildingCount, ownedBy } from './selectors.ts';
import type { GameState, PlayerState, TradeOffer } from './types.ts';

/**
 * Secret objectives — Intermediate Mode only, and only when the host left them enabled.
 *
 * Each starting player is dealt one objective when the game starts. It is theirs alone until the
 * game ends: the server sends a device only its own (redactObjectives), and nothing about an
 * objective is ever written to an event, a transaction or a broadcast while the game is running.
 * When the game finishes every objective is checked against the same final state, the bonuses are
 * paid by the bank, and only then is the winner decided.
 *
 * The pool is this one typed registry. Adding an objective means adding an id and a definition.
 */

export const OBJECTIVE_IDS = ['PROPERTY_MOGUL', 'BUILDER', 'CASH_GUARDIAN', 'DEAL_MAKER'] as const;
export type ObjectiveId = (typeof OBJECTIVE_IDS)[number];

/** A completed player-to-player property trade (public: every trade is announced to the table). */
export interface ObjectiveTrade {
  /** The ACCEPT_TRADE action that executed it — the same id its undo entry carries. */
  actionId: string;
  tradeId: string;
  playerIds: [string, string];
}

export interface ObjectiveResult {
  playerId: string;
  objectiveId: ObjectiveId;
  completed: boolean;
  /** The bonus actually paid: the scaled reward, or 0. */
  reward: number;
  /** One sentence explaining the outcome. */
  detail: string;
}

export interface ObjectivesState {
  /** Player → objective. While the game is running a device receives only its own entry. */
  assignments: Record<string, ObjectiveId>;
  /** Trades that currently count towards Deal Maker. An undone trade is removed again. */
  trades: ObjectiveTrade[];
  /** Null while the game runs. Set exactly once, when it finishes. */
  results: ObjectiveResult[] | null;
}

/** An objective's numbers for one game: the base values scaled to that game's starting cash. */
export interface ObjectiveTerms {
  reward: number;
  /** The rupee target, for objectives that have one. */
  cashTarget: number | null;
}

export interface ObjectiveCheck {
  completed: boolean;
  /** Where the player stands, in a few words ("2 of 3 houses"). */
  progress: string;
}

type ObjectiveStateView = Pick<GameState, 'players' | 'properties' | 'mode' | 'intermediate' | 'objectives'>;

export interface ObjectiveDefinition {
  id: ObjectiveId;
  name: string;
  /** Bonus at the standard starting cash. The paid reward scales with the game's starting cash. */
  baseReward: number;
  /** Rupee target at the standard starting cash (scales the same way), or null for a quantity goal. */
  baseCashTarget: number | null;
  /** Fixed count the goal needs. Never scales. */
  quantity: number;
  /** What the engine has to record during play for this objective (everything else is read from the final state). */
  tracks: 'COMPLETED_TRADES' | null;
  /** The private description, with this game's numbers. */
  describe: (terms: ObjectiveTerms) => string;
  /** Checks the goal against a state. Used live for the owner's private progress, and once at the end for the result. */
  evaluate: (state: ObjectiveStateView, playerId: string, terms: ObjectiveTerms) => ObjectiveCheck;
  /** The same standing as "have / need" lines for the owner's own screen ("2 / 3 houses"). Read from the state, never stored. */
  measures: (state: ObjectiveStateView, playerId: string, terms: ObjectiveTerms) => string[];
}

const count = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Installments overdue plus loans in default: either one disqualifies Cash Guardian. */
function loanPaymentsBehind(state: ObjectiveStateView, playerId: string): number {
  const eco = economyOf(state);
  return eco ? overdueInstallments(eco, playerId).length + defaultedLoans(eco, playerId).length : 0;
}

export const OBJECTIVES: Record<ObjectiveId, ObjectiveDefinition> = {
  PROPERTY_MOGUL: {
    id: 'PROPERTY_MOGUL',
    name: 'Property Mogul',
    baseReward: 5000,
    baseCashTarget: 12000,
    quantity: 3,
    tracks: null,
    describe: (t) =>
      `When the game ends, own at least 3 properties whose original prices add up to ${formatINR(t.cashTarget ?? 0)} or more. The price printed on the deed counts, not the market value. Mortgaged properties still count.`,
    evaluate: (state, playerId, t) => {
      const keys = ownedBy(state, playerId);
      // The deed price, read from the board data: market swings never move this target.
      const total = keys.reduce((sum, key) => sum + getDeed(key).price, 0);
      return {
        completed: keys.length >= 3 && total >= (t.cashTarget ?? 0),
        progress: `${count(keys.length, 'property', 'properties')} with original prices of ${formatINR(total)} (needs 3 or more, ${formatINR(t.cashTarget ?? 0)})`,
      };
    },
    measures: (state, playerId, t) => {
      const keys = ownedBy(state, playerId);
      const total = keys.reduce((sum, key) => sum + getDeed(key).price, 0);
      return [`${keys.length} / 3 properties`, `${formatINR(total)} / ${formatINR(t.cashTarget ?? 0)} property value`];
    },
  },
  BUILDER: {
    id: 'BUILDER',
    name: 'The Builder',
    baseReward: 4000,
    baseCashTarget: null,
    quantity: 3,
    tracks: null,
    describe: () =>
      'When the game ends, have at least 3 houses standing on properties you own. A hotel replaces its houses, so a hotel does not count — keep houses on the board.',
    evaluate: (state, playerId) => {
      // Houses as the game state holds them: a hotel is stored with no houses, so it adds none.
      const { houses } = buildingCount(state, playerId);
      return { completed: houses >= 3, progress: `${count(houses, 'house')} (needs 3)` };
    },
    measures: (state, playerId) => [`${buildingCount(state, playerId).houses} / 3 houses`],
  },
  CASH_GUARDIAN: {
    id: 'CASH_GUARDIAN',
    name: 'Cash Guardian',
    baseReward: 4000,
    baseCashTarget: 12000,
    quantity: 0,
    tracks: null,
    describe: (t) =>
      `When the game ends, hold at least ${formatINR(t.cashTarget ?? 0)} in cash, with no loan installment overdue and no loan in default. Only cash counts — not property, rent you expect, or money you could still borrow.`,
    evaluate: (state, playerId, t) => {
      const cash = state.players.find((p) => p.id === playerId)?.balance ?? 0;
      const behind = loanPaymentsBehind(state, playerId);
      return {
        completed: cash >= (t.cashTarget ?? 0) && behind === 0,
        progress: `${formatINR(cash)} cash (needs ${formatINR(t.cashTarget ?? 0)})${behind > 0 ? ', with a loan payment overdue or in default' : ''}`,
      };
    },
    measures: (state, playerId, t) => [
      `${formatINR(state.players.find((p) => p.id === playerId)?.balance ?? 0)} / ${formatINR(t.cashTarget ?? 0)} cash`,
      loanPaymentsBehind(state, playerId) > 0 ? 'A loan payment is overdue or in default' : 'No overdue installments',
    ],
  },
  DEAL_MAKER: {
    id: 'DEAL_MAKER',
    name: 'Deal Maker',
    baseReward: 4000,
    baseCashTarget: null,
    quantity: 2,
    tracks: 'COMPLETED_TRADES',
    describe: () =>
      'Complete at least 2 property trades with other players during the game. A trade counts once it is accepted and a property changes hands. Offers that are rejected, cancelled or undone do not count.',
    evaluate: (state, playerId) => {
      const done = completedTradeCount(state.objectives, playerId);
      return { completed: done >= 2, progress: `${count(done, 'trade')} completed (needs 2)` };
    },
    measures: (state, playerId) => [`${completedTradeCount(state.objectives, playerId)} / 2 trades`],
  },
};

/** How many trades currently count for a player. */
export function completedTradeCount(objectives: Pick<ObjectivesState, 'trades'> | null | undefined, playerId: string): number {
  return (objectives?.trades ?? []).filter((t) => t.playerIds.includes(playerId)).length;
}

/**
 * base × startingCash / the standard starting cash, to the nearest ₹100 (half up). Whole-number
 * arithmetic only, with one rounding. Rewards and rupee targets both scale through here.
 */
export function scaleToStartingCash(base: number, startingCash: number): number {
  const den = RULES.startingCash * 100;
  return Math.floor((base * startingCash * 2 + den) / (den * 2)) * 100;
}

export function objectiveTerms(id: ObjectiveId, startingCash: number): ObjectiveTerms {
  const def = OBJECTIVES[id];
  return {
    reward: scaleToStartingCash(def.baseReward, startingCash),
    cashTarget: def.baseCashTarget === null ? null : scaleToStartingCash(def.baseCashTarget, startingCash),
  };
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

/** Who is dealt an objective: every player who is in the game when it starts. */
export function objectiveEligible(player: Pick<PlayerState, 'status'>): boolean {
  return player.status === 'ACTIVE';
}

/**
 * Deals `players` objectives from the pool, drawn with the given RNG (the server's secure one).
 * The pool is shuffled and dealt one each; only when it runs out — more players than objectives —
 * is it shuffled again, so nobody shares an objective until every objective is in play.
 */
export function dealObjectives(players: number, random: () => number): ObjectiveId[] {
  const dealt: ObjectiveId[] = [];
  while (dealt.length < players) {
    const pool = [...OBJECTIVE_IDS];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.min(Math.max(Math.floor(random() * (i + 1)), 0), i);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    dealt.push(...pool.slice(0, players - dealt.length));
  }
  return dealt;
}

/** START_GAME, Intermediate with objectives enabled: one objective per starting player, once. No event names them. */
export function assignObjectives(d: Draft, starters: readonly PlayerState[]): void {
  if (d.state.objectives) return;
  const eligible = starters.filter(objectiveEligible);
  const dealt = dealObjectives(eligible.length, d.ctx.random);
  d.state.objectives = {
    assignments: Object.fromEntries(eligible.map((p, i) => [p.id, dealt[i]!])),
    trades: [],
    results: null,
  };
}

// ---------------------------------------------------------------------------
// Tracking (Deal Maker)
// ---------------------------------------------------------------------------

/** ACCEPT_TRADE went through: a property changed hands between two players. Recorded once per trade. */
export function recordObjectiveTrade(d: Draft, trade: Pick<TradeOffer, 'id' | 'fromPlayerId' | 'toPlayerId' | 'offeredPropertyKeys' | 'requestedPropertyKeys'>): void {
  const objectives = d.state.objectives;
  if (!objectives || objectives.results) return;
  if (trade.fromPlayerId === trade.toPlayerId) return;
  if (trade.offeredPropertyKeys.length + trade.requestedPropertyKeys.length === 0) return;
  if (objectives.trades.some((t) => t.tradeId === trade.id)) return;
  objectives.trades.push({ actionId: d.ctx.actionId, tradeId: trade.id, playerIds: [trade.fromPlayerId, trade.toPlayerId] });
}

/** That trade was undone: it never happened, so it no longer counts. */
export function forgetObjectiveTrade(d: Draft, actionId: string): void {
  const objectives = d.state.objectives;
  if (!objectives || objectives.results) return;
  objectives.trades = objectives.trades.filter((t) => t.actionId !== actionId);
}

// ---------------------------------------------------------------------------
// The end of the game
// ---------------------------------------------------------------------------

/**
 * Called by finishGame, after the game is closed and before the winner is ranked:
 * every objective is checked against this one final state, each completed one is paid by the bank
 * as its own OBJECTIVE_REWARD ledger entry, and the results are stored. Runs at most once per game.
 *
 * Only a player still in the game can earn the bonus. Someone who went bankrupt or left has their
 * objective revealed with everyone else's, as not completed.
 */
export function finalizeObjectives(d: Draft): void {
  const objectives = d.state.objectives;
  if (!objectives || objectives.results) return;
  const startingCash = configOf(d.state).startingCash;
  // Checked first, all against the same state; paid afterwards, so no bonus can help complete another objective.
  const results: ObjectiveResult[] = [...d.state.players]
    .sort((a, b) => a.seat - b.seat)
    .flatMap((player) => {
      const objectiveId = objectives.assignments[player.id];
      if (!objectiveId) return [];
      const terms = objectiveTerms(objectiveId, startingCash);
      if (player.status !== 'ACTIVE') {
        const why = player.status === 'BANKRUPT' ? 'Went bankrupt' : 'Left the game';
        return [{ playerId: player.id, objectiveId, completed: false, reward: 0, detail: `${why} before it ended — no bonus.` }];
      }
      const check = OBJECTIVES[objectiveId].evaluate(d.state, player.id, terms);
      return [{ playerId: player.id, objectiveId, completed: check.completed, reward: check.completed ? terms.reward : 0, detail: `Finished with ${check.progress}.` }];
    });
  for (const r of results) {
    const name = OBJECTIVES[r.objectiveId].name;
    if (r.reward > 0) d.transfer({ type: 'OBJECTIVE_REWARD', from: null, to: r.playerId, amount: r.reward, memo: `Secret objective bonus: ${name}` });
    d.event(
      'OBJECTIVE_RESULT',
      r.playerId,
      r.completed ? `${d.name(r.playerId)} completed the secret objective “${name}” — ${formatINR(r.reward)} bonus` : `${d.name(r.playerId)} did not complete the secret objective “${name}”`,
      { objectiveId: r.objectiveId, completed: r.completed, reward: r.reward },
    );
  }
  objectives.results = results;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ObjectiveView {
  definition: ObjectiveDefinition;
  terms: ObjectiveTerms;
  description: string;
  check: ObjectiveCheck;
  /** "have / need" lines for the progress display. */
  measures: string[];
}

/** A player's objective as their own device shows it, or null when they have none. */
export function objectiveView(state: ObjectiveStateView & { config?: GameState['config'] | null }, playerId: string): ObjectiveView | null {
  const id = state.objectives?.assignments[playerId];
  if (!id) return null;
  const definition = OBJECTIVES[id];
  const terms = objectiveTerms(id, configOf(state).startingCash);
  return {
    definition,
    terms,
    description: definition.describe(terms),
    check: definition.evaluate(state, playerId, terms),
    measures: definition.measures(state, playerId, terms),
  };
}

/**
 * The state as one player may see it. THE privacy boundary for objectives: the server passes every
 * snapshot through here before it leaves. While the game is running, other players' objectives are
 * removed; once it has finished, everything is revealed.
 */
export function redactObjectives(state: GameState, viewerId: string | null): GameState {
  const objectives = state.objectives;
  if (!objectives || state.status === 'FINISHED') return state;
  const own = viewerId ? objectives.assignments[viewerId] : undefined;
  return { ...state, objectives: { ...objectives, assignments: own && viewerId ? { [viewerId]: own } : {} } };
}
