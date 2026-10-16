import {
  auctionAcceptUntil,
  auctionOpensAt,
  buildingCost,
  formatINR,
  getDeed,
  minimumNextBid,
  type AuctionState,
  type GameState,
  type PropertyKey,
} from '../engine/index.ts';
import { BOT_POLICY } from './config.ts';
import type { Components } from './types.ts';
import { assess, attribute, bookValue, delta, knownOutflows, weigh, type Assessment, type ValuationContext } from './valuation.ts';

/**
 * Auctions — the bank's auction of a declined property and (Capital) a player's resale. The bot values
 * winning at a price exactly as it values any other move: the position in which it owns the property (with
 * whatever stands on it) and has paid that price, against the position now. It bids only while the next
 * legal bid is at or below the most that is still worth it, never above its cash, never past the amount that
 * would leave it unable to meet what it already owes, and never just because it has been bidding.
 */

/** The position in which `buyer` has won `auction` at `price` (rules of finalizeAuction / finalizeResale). */
export function wonAt(state: GameState, auction: Pick<AuctionState, 'propertyKey' | 'resale'>, buyerId: string, price: number): GameState {
  const key = auction.propertyKey;
  const prop = state.properties[key];
  const sellerId = auction.resale?.sellerId ?? null;
  return {
    ...state,
    players: state.players.map((p) => (p.id === buyerId ? { ...p, balance: p.balance - price } : p.id === sellerId ? { ...p, balance: p.balance + price } : p)),
    properties: { ...state.properties, [key]: { ...prop, ownerId: buyerId } },
  };
}

export interface BidValue {
  score: number;
  components: Components;
}

/**
 * Personality-weighted value to the bot of winning at `price`. A price below the property's book value is a
 * bargain: that part of the gain is attributed to the market dimension (an Opportunist's specialty) rather
 * than counted twice. Hard also values keeping the property from the opponent who would gain most by it.
 */
export function valueOfWinning(vc: ValuationContext, base: Assessment, auction: Pick<AuctionState, 'propertyKey' | 'resale'>, price: number, denial: number): BidValue {
  const after = wonAt(vc.obs.state, auction, vc.obs.botId, price);
  let c = delta(assess(vc, after).components, base.components);
  const prop = vc.obs.state.properties[auction.propertyKey];
  const book = bookValue(vc.obs.state, auction.propertyKey) + (auction.resale ? buildingCost(prop) : 0);
  const bargain = Math.max(0, Math.min(book - price, c.wealth));
  if (bargain > 0) c = attribute(c, 'wealth', 'market', bargain);
  if (denial > 0) c = { ...c, group: c.group + denial };
  return { score: weigh(vc, c), components: c };
}

/**
 * Hard only: what keeping `key` away from opponents is worth — the largest increase in rent income any one
 * opponent would get from owning it (their sets complete or grow), times the rivalry weight. Public
 * information only: who owns what and how the board moves.
 */
export function denialValue(vc: ValuationContext, key: PropertyKey, exceptIds: readonly string[] = []): number {
  if (!vc.tuning.denialValue) return 0;
  const s = vc.obs.state;
  let worst = 0;
  for (const p of s.players) {
    if (p.status !== 'ACTIVE' || p.id === vc.obs.botId || exceptIds.includes(p.id)) continue;
    const before = assess(vc, s, p.id);
    const after = assess(vc, { ...s, properties: { ...s.properties, [key]: { ...s.properties[key], ownerId: p.id } } }, p.id);
    worst = Math.max(worst, after.income - before.income);
  }
  return vc.tuning.rivalryWeight * worst * 0.5;
}

/**
 * The most the bot would pay: the highest price, on the auction's increments, whose weighted value is
 * still at least the minimum improvement, and which leaves enough cash for what is already owed.
 */
export function maximumBid(vc: ValuationContext, base: Assessment, auction: AuctionState): number {
  const me = vc.obs.me;
  const step = Math.max(1, auction.minimumIncrement);
  const floor = minimumNextBid(auction);
  const owed = knownOutflows(vc.obs.state, me.id);
  const cap = Math.min(me.balance, me.balance - owed);
  if (cap < floor) return 0;
  const denial = denialValue(vc, auction.propertyKey, auction.resale ? [auction.resale.sellerId] : []);
  const worth = (price: number) => valueOfWinning(vc, base, auction, price, denial).score >= BOT_POLICY.decisions.minimumImprovement;
  if (!worth(floor)) return 0;
  // Value falls as the price rises: binary search over the increments.
  let lo = 0;
  let hi = Math.floor((cap - floor) / step);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (worth(floor + mid * step)) lo = mid;
    else hi = mid - 1;
  }
  return floor + lo * step;
}

export interface AuctionMove {
  kind: 'BID' | 'PASS' | 'WAIT' | 'CLOSE';
  amount?: number;
  reason: string;
}

/** What the bot does in an open auction right now. */
export function auctionMove(vc: ValuationContext, base: Assessment, auction: AuctionState): AuctionMove {
  const me = vc.obs.me;
  const now = vc.obs.nowMs;
  const name = getDeed(auction.propertyKey).name;
  if (now >= auctionAcceptUntil(auction)) return { kind: 'CLOSE', reason: `The ${name} auction's time is up.` };
  if (auction.resale?.sellerId === me.id) return { kind: 'WAIT', reason: 'Its own property is being auctioned.' };
  if (!auction.participantIds.includes(me.id) || auction.passedIds.includes(me.id)) return { kind: 'WAIT', reason: 'Not bidding in this auction.' };
  if (auction.highBidderId === me.id) return { kind: 'WAIT', reason: 'Holds the highest bid.' };
  if (now < auctionOpensAt(auction)) return { kind: 'WAIT', reason: 'Bidding has not opened yet.' };
  const floor = minimumNextBid(auction);
  const max = maximumBid(vc, base, auction);
  if (max < floor) {
    return {
      kind: 'PASS',
      reason: max === 0 && me.balance < floor ? `Can't afford the next bid on ${name}.` : `The next bid on ${name} (${formatINR(floor)}) is above what it is worth to it.`,
    };
  }
  const step = Math.max(1, auction.minimumIncrement);
  let amount = floor;
  if (vc.tuning.jumpBids) {
    if (auction.highBid === null) {
      amount = Math.max(floor, Math.floor((max * vc.personality.auctionOpening) / step) * step);
    } else {
      const jump = Math.floor(((max - floor) * BOT_POLICY.auction.jumpShare) / step) * step;
      amount = floor + Math.max(0, jump);
    }
  }
  amount = Math.min(max, Math.max(floor, amount));
  return { kind: 'BID', amount, reason: `Bids ${formatINR(amount)} on ${name}; it would pay up to ${formatINR(max)}.` };
}

