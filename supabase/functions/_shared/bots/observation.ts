import {
  buildingCost,
  BUSINESS_MVP_RULES as RULES,
  configOf,
  financesHidden,
  getDeed,
  ownedBy,
  redactEndVote,
  redactFinances,
  redactObjectives,
  type GameState,
} from '../engine/index.ts';
import type { BotObservation } from './types.ts';

/**
 * THE information boundary of a bot. A bot decides from exactly what the server would send its seat's own
 * phone: the snapshot passed through redactObjectives, redactEndVote and redactFinances for that seat — the
 * same functions db.loadSnapshot uses. With hidden finances it therefore never sees another player's cash,
 * loans, credit score, insurance, ballot, the amounts of their private payments or their secret objective,
 * whatever difficulty it plays at. Hard estimates those things from public information; it does not read them.
 *
 * Callers pass the full authoritative state (the server holds it anyway); nothing beyond the returned
 * observation is handed to the strategy code.
 */
export function observe(state: GameState, botId: string, nowMs: number): BotObservation {
  const snapshot = redactFinances(
    { state: redactEndVote(redactObjectives(state, botId), botId), events: [], transactions: [], serverTime: new Date(nowMs).toISOString() },
    botId,
  );
  const visible = snapshot.state;
  const me = visible.players.find((p) => p.id === botId);
  if (!me) throw new Error('That seat is not in this game.');
  const hidden = financesHidden(visible);
  const opponentCash: BotObservation['opponentCash'] = {};
  for (const p of visible.players) {
    if (p.id === botId || p.status !== 'ACTIVE') continue;
    opponentCash[p.id] = hidden ? { amount: estimateCash(visible, p.id), known: false } : { amount: p.balance, known: true };
  }
  return { state: visible, botId, me, opponentCash, financesHidden: hidden, nowMs };
}

/**
 * A rough estimate of a player's cash from what the whole table can see: the starting cash, a Start reward
 * for every lap they have completed (laps are public), less what their properties and buildings cost at the
 * deed prices, plus the mortgage money on what they have mortgaged. Rent, cards, taxes and loans are not in
 * it — that is exactly what hidden finances keep private. Never below zero.
 */
export function estimateCash(state: GameState, playerId: string): number {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 0;
  let cash = configOf(state).startingCash + player.circuits * RULES.start.passReward;
  for (const key of ownedBy(state, playerId)) {
    const prop = state.properties[key];
    const deed = getDeed(key);
    cash -= deed.price + buildingCost(prop);
    if (prop.mortgaged) cash += deed.mortgageValue;
  }
  return Math.max(0, cash);
}

/**
 * The observed state with each opponent's cash replaced by what this bot believes it to be (the real
 * figure only when finances are open). Used to test whether a deal could execute; the server judges the
 * real thing when the action is sent.
 */
export function believedState(obs: BotObservation): GameState {
  if (!obs.financesHidden) return obs.state;
  return {
    ...obs.state,
    players: obs.state.players.map((p) => (p.id in obs.opponentCash ? { ...p, balance: obs.opponentCash[p.id]!.amount } : p)),
  };
}
