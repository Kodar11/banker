import {
  buildingCost,
  formatINR,
  getDeed,
  groupMembers,
  mandatoryPaymentsOwed,
  ownedBy,
  BUSINESS_MVP_RULES as RULES,
  type GameAction,
  type GameState,
  type PropertyKey,
  type TradeOffer,
} from '../engine/index.ts';
import { BOT_POLICY } from './config.ts';
import { dryRun } from './engineAccess.ts';
import { believedState } from './observation.ts';
import { mixSeed } from './random.ts';
import { DIMENSIONS, type Components } from './types.ts';
import { assess, attribute, bookValue, delta, knownOutflows, shortfallPenalty, weigh, type ValuationContext } from './valuation.ts';

/**
 * Player-to-player trades, valued on both sides. The bot's own side is its full personality-weighted
 * valuation of the position after the exchange; the other side is the same model applied, neutrally, to
 * what is public about that player (their cash only as this bot may know or estimate it). Nothing here
 * changes the trade rules: every offer the bot makes or accepts is checked by the engine, and executed by
 * it on the server.
 */

export type TradeShape = Pick<TradeOffer, 'fromPlayerId' | 'toPlayerId' | 'offeredPropertyKeys' | 'requestedPropertyKeys' | 'offeredMoney' | 'requestedMoney'>;

/** The position after `t` executes (acceptTrade: money both ways, ownership moves with the buildings and mortgages). */
export function afterTrade(state: GameState, t: TradeShape): GameState {
  const net = t.offeredMoney - t.requestedMoney;
  const properties = { ...state.properties };
  for (const k of t.offeredPropertyKeys) properties[k] = { ...properties[k], ownerId: t.toPlayerId };
  for (const k of t.requestedPropertyKeys) properties[k] = { ...properties[k], ownerId: t.fromPlayerId };
  return {
    ...state,
    properties,
    players: state.players.map((p) => (p.id === t.fromPlayerId ? { ...p, balance: p.balance - net } : p.id === t.toPlayerId ? { ...p, balance: p.balance + net } : p)),
  };
}

/** What one side hands over, at book value (cash + properties with their buildings). */
function givenValue(state: GameState, t: TradeShape, side: string): number {
  const keys = side === t.fromPlayerId ? t.offeredPropertyKeys : t.requestedPropertyKeys;
  const money = side === t.fromPlayerId ? t.offeredMoney : t.requestedMoney;
  return money + keys.reduce((s, k) => s + bookValue(state, k) + buildingCost(state.properties[k]), 0);
}

export interface TradeValue {
  /** Personality-weighted gain to the bot, after the rivalry adjustment. */
  score: number;
  components: Components;
  /** The other side's gain on a neutral reading of public information. */
  partnerGain: number;
  /** What the bot needs the gain to clear to agree. */
  threshold: number;
  partnerThreshold: number;
}

const sum = (c: Components) => DIMENSIONS.reduce((s, d) => s + c[d], 0);

/** Values trade `t` (between the bot and one other player) from the bot's side, on the bot's beliefs. */
export function valueTrade(vc: ValuationContext, t: TradeShape, believed: GameState = believedState(vc.obs)): TradeValue {
  const me = vc.obs.botId;
  const partner = t.fromPlayerId === me ? t.toPlayerId : t.fromPlayerId;
  const after = afterTrade(believed, t);
  const before = assess(vc, believed, me);
  let c = delta(assess(vc, after, me).components, before.components);
  // Selling income for cash is never "safer" just because cash is below the strategic reserve: a deal's
  // liquidity gain counts only as far as it covers what is actually owed (O_known). Paying cash in a deal
  // still costs its full liquidity. (Without this a cautious bot sells its properties away. See docs/bots.)
  if (c.liquidity > 0) {
    const owed = knownOutflows(believed, me);
    const cashAfter = after.players.find((p) => p.id === me)?.balance ?? before.cash;
    const relief = shortfallPenalty(owed - before.cash, Math.max(1, owed)) - shortfallPenalty(owed - cashAfter, Math.max(1, owed));
    c = { ...c, liquidity: Math.min(c.liquidity, Math.max(0, relief)) };
  }
  const raw = sum(c);
  if (raw > 0) c = attribute(c, 'wealth', 'negotiation', raw * BOT_POLICY.value.negotiationShare);
  const partnerGain = sum(delta(assess(vc, after, partner).components, assess(vc, believed, partner).components));
  const score = weigh(vc, c) - vc.tuning.rivalryWeight * Math.max(0, partnerGain);
  const threshold = Math.max(BOT_POLICY.trade.minimumGain, vc.personality.tradeMargin * givenValue(believed, t, me));
  const partnerThreshold = Math.max(BOT_POLICY.trade.minimumGain / 2, 0.05 * givenValue(believed, t, partner));
  return { score, components: c, partnerGain, threshold, partnerThreshold };
}

const sameKeys = (a: readonly PropertyKey[], b: readonly PropertyKey[]) => a.length === b.length && a.every((k) => b.includes(k));

/** The bot already proposed this exchange (same partner, same properties), whatever became of it, as far as the record goes. */
function alreadyProposed(state: GameState, me: string, to: string, offered: readonly PropertyKey[], requested: readonly PropertyKey[]): boolean {
  return state.trades.some((t) => t.fromPlayerId === me && t.toPlayerId === to && sameKeys(t.offeredPropertyKeys, offered) && sameKeys(t.requestedPropertyKeys, requested));
}

export interface TradeMove {
  action: GameAction;
  kind: string;
  reason: string;
}

/** The largest step-multiple x in [lo, hi] with pred(x) true, assuming pred is true up to some point and false after. */
function lastTrue(lo: number, hi: number, step: number, pred: (x: number) => boolean): number | null {
  if (hi < lo || !pred(lo)) return null;
  let a = 0;
  let b = Math.floor((hi - lo) / step);
  while (a < b) {
    const mid = Math.ceil((a + b) / 2);
    if (pred(lo + mid * step)) a = mid;
    else b = mid - 1;
  }
  return lo + a * step;
}

/** The smallest step-multiple x in [lo, hi] with pred(x) true, assuming pred is false up to some point and true after. */
function firstTrue(lo: number, hi: number, step: number, pred: (x: number) => boolean): number | null {
  if (hi < lo || !pred(hi)) return null;
  let a = 0;
  let b = Math.floor((hi - lo) / step);
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (pred(lo + mid * step)) b = mid;
    else a = mid + 1;
  }
  return lo + a * step;
}

/**
 * An offer made to the bot: accept it if it clears the bot's threshold; otherwise counter (Normal/Hard) when
 * asking for more money would make it acceptable to the bot and still, by the bot's reading, to the other
 * side — once per exchange — or reject it.
 */
export function respondToOffer(vc: ValuationContext, trade: TradeOffer): TradeMove {
  const me = vc.obs.botId;
  const believed = believedState(vc.obs);
  // Judged as if it goes through: the proposer is assumed to hold the money they offered (the server checks).
  const planning: GameState = {
    ...believed,
    players: believed.players.map((p) => (p.id === trade.fromPlayerId ? { ...p, balance: Math.max(p.balance, trade.offeredMoney) } : p)),
  };
  const from = vc.obs.state.players.find((p) => p.id === trade.fromPlayerId)?.name ?? 'another player';
  const accept: GameAction = { type: 'ACCEPT_TRADE', tradeId: trade.id };
  const reject: GameAction = { type: 'REJECT_TRADE', tradeId: trade.id };
  if (!dryRun(planning, me, accept, vc.obs.nowMs)) return { action: reject, kind: 'TRADE_REJECT', reason: `Rejects ${from}'s offer: it can't go through as it stands.` };
  const v = valueTrade(vc, trade, planning);
  if (v.score >= v.threshold) {
    return { action: accept, kind: 'TRADE_ACCEPT', reason: `Accepts ${from}'s offer: worth about ${formatINR(v.score)} to it (needs ${formatINR(v.threshold)}).` };
  }
  if (vc.tuning.counteroffers && !alreadyProposed(vc.obs.state, me, trade.fromPlayerId, trade.requestedPropertyKeys, trade.offeredPropertyKeys)) {
    const counter = counterOffer(vc, trade, planning);
    if (counter) return counter;
  }
  return { action: reject, kind: 'TRADE_REJECT', reason: `Rejects ${from}'s offer: worth ${formatINR(v.score)} to it, below its ${formatINR(v.threshold)} threshold.` };
}

function counterOffer(vc: ValuationContext, trade: TradeOffer, believed: GameState): TradeMove | null {
  const me = vc.obs.botId;
  const partner = trade.fromPlayerId;
  const partnerCash = vc.obs.opponentCash[partner]?.amount ?? 0;
  const base = trade.offeredMoney - trade.requestedMoney; // net cash to the bot as offered
  const shape = (extra: number): TradeShape => {
    const net = base + extra;
    return {
      fromPlayerId: me,
      toPlayerId: partner,
      offeredPropertyKeys: trade.requestedPropertyKeys,
      requestedPropertyKeys: trade.offeredPropertyKeys,
      offeredMoney: Math.max(0, -net),
      requestedMoney: Math.max(0, net),
    };
  };
  const step = 100;
  const maxExtra = Math.max(0, partnerCash - Math.max(0, base));
  const extra = firstTrue(step, Math.max(step, maxExtra), step, (x) => {
    const v = valueTrade(vc, shape(x), believed);
    return v.score >= v.threshold;
  });
  if (extra === null) return null;
  const t = shape(extra);
  const v = valueTrade(vc, t, believed);
  if (v.partnerGain < v.partnerThreshold) return null;
  const action: GameAction = { type: 'CREATE_TRADE', toPlayerId: partner, offeredPropertyKeys: [...t.offeredPropertyKeys], requestedPropertyKeys: [...t.requestedPropertyKeys], offeredMoney: t.offeredMoney, requestedMoney: t.requestedMoney };
  if (!dryRun(believed, me, action, vc.obs.nowMs)) return null;
  return { action, kind: 'TRADE_COUNTER', reason: `Counters with ${formatINR(extra)} more in its favour: the original offer fell short of its threshold.` };
}

/** One of the bot's own open offers no longer worth it to the bot (the board changed): withdraw it. */
export function staleOwnOffer(vc: ValuationContext): TradeMove | null {
  const me = vc.obs.botId;
  for (const t of vc.obs.state.trades) {
    if (t.status !== 'PENDING' || t.fromPlayerId !== me) continue;
    const v = valueTrade(vc, t);
    if (v.score < Math.max(0, v.threshold / 2)) return { action: { type: 'CANCEL_TRADE', tradeId: t.id }, kind: 'TRADE_CANCEL', reason: 'Withdraws its own offer: it is no longer worth it.' };
  }
  return null;
}

/** Whether this is one of the bot's turns to look for a deal (personality cadence, deterministic per seat and turn). */
export function tradeTurn(vc: ValuationContext): boolean {
  const cadence = vc.personality.tradeCadence;
  if (!vc.tuning.proactiveTrades || cadence <= 0) return false;
  return mixSeed(vc.seed, 'trade-turn', vc.obs.state.turn.number) % cadence === 0;
}

/**
 * A deal the bot proposes: a property of another player that is worth more to the bot (usually because it
 * completes or grows a set), bought for cash pitched between what the other side should accept and the most
 * it is worth to the bot — or swapped for a property that helps the other side. Bounded: a handful of the
 * most promising properties, one proposal at a time, never one it already proposed and saw turned down.
 */
export function proposeTrade(vc: ValuationContext): TradeMove | null {
  const s = vc.obs.state;
  const me = vc.obs.botId;
  if (s.trades.some((t) => t.status === 'PENDING' && t.fromPlayerId === me)) return null;
  if (s.trades.filter((t) => t.status === 'PENDING').length >= RULES.trades.maxPendingPerGame) return null;
  const believed = believedState(vc.obs);
  const mine = ownedBy(s, me);
  const myGroups = new Set(mine.map((k) => getDeed(k).group));
  const spend = Math.max(0, vc.obs.me.balance - knownOutflows(s, me) - mandatoryPaymentsOwed(s, me));

  type Option = { keys: PropertyKey[]; to: string; give: PropertyKey[]; relevance: number };
  const options: Option[] = [];
  for (const p of s.players) {
    if (p.id === me || p.status !== 'ACTIVE') continue;
    const theirs = ownedBy(s, p.id);
    const theirGroups = new Set(theirs.map((k) => getDeed(k).group));
    for (const key of theirs) {
      const group = getDeed(key).group;
      const held = groupMembers(group).filter((k) => s.properties[k]?.ownerId === me).length;
      if (held === 0 && vc.profile.personality !== 'opportunist') continue;
      options.push({ keys: [key], to: p.id, give: [], relevance: held * 10 + bookValue(s, key) / 1000 });
      // A swap: something of the bot's in a group the other side collects.
      for (const mineKey of mine) {
        if (getDeed(mineKey).group === group || !theirGroups.has(getDeed(mineKey).group) || myGroups.size === 0) continue;
        options.push({ keys: [key], to: p.id, give: [mineKey], relevance: held * 10 + 5 });
      }
    }
  }
  options.sort((a, b) => b.relevance - a.relevance);

  let top: { move: TradeMove; score: number } | null = null;
  for (const o of options.slice(0, BOT_POLICY.trade.maxCandidates)) {
    if (alreadyProposed(s, me, o.to, o.give, o.keys)) continue;
    const theirCash = vc.obs.opponentCash[o.to]?.amount ?? 0;
    // cash > 0: the bot pays; cash < 0: the other side pays the bot.
    const shape = (cash: number): TradeShape => ({
      fromPlayerId: me,
      toPlayerId: o.to,
      offeredPropertyKeys: o.give,
      requestedPropertyKeys: o.keys,
      offeredMoney: Math.max(0, cash),
      requestedMoney: Math.max(0, -cash),
    });
    const step = 100;
    const lo = o.give.length ? -Math.floor(theirCash / step) * step : 0;
    const hi = Math.floor(spend / step) * step;
    if (hi < lo) continue;
    const mineOk = (x: number) => {
      const v = valueTrade(vc, shape(x), believed);
      return v.score >= v.threshold;
    };
    const theirsOk = (x: number) => {
      const v = valueTrade(vc, shape(x), believed);
      return v.partnerGain >= v.partnerThreshold;
    };
    const most = lastTrue(lo, hi, step, mineOk);
    if (most === null) continue;
    const least = firstTrue(lo, most, step, theirsOk);
    if (least === null) continue;
    const cash = least + Math.round(((most - least) * vc.personality.offerSplit) / step) * step;
    if (o.give.length === 0 && cash <= 0) continue;
    const t = shape(cash);
    const action: GameAction = { type: 'CREATE_TRADE', toPlayerId: o.to, offeredPropertyKeys: [...t.offeredPropertyKeys], requestedPropertyKeys: [...t.requestedPropertyKeys], offeredMoney: t.offeredMoney, requestedMoney: t.requestedMoney };
    if (!dryRun(believed, me, action, vc.obs.nowMs)) continue;
    const v = valueTrade(vc, t, believed);
    const what = o.keys.map((k) => getDeed(k).name).join(', ');
    const give = [...o.give.map((k) => getDeed(k).name), ...(t.offeredMoney ? [formatINR(t.offeredMoney)] : [])].join(' + ');
    const move: TradeMove = { action, kind: 'TRADE_PROPOSE', reason: `Offers ${give || 'a deal'} for ${what}${t.requestedMoney ? ` and ${formatINR(t.requestedMoney)}` : ''}: worth about ${formatINR(v.score)} to it.` };
    if (!top || v.score > top.score) top = { move, score: v.score };
  }
  return top?.move ?? null;
}

