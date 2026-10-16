import type { GameAction } from './actions.ts';
import { getDeed, PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';
import type { Draft } from './draft.ts';
import { fail } from './errors.ts';
import { formatINR } from './format.ts';
import { INTERMEDIATE_RULES as IR } from './intermediateConfig.ts';
import { bankruptcyBlockerNow, raiseFundsOptions } from './estate.ts';
import { pickFrom } from './intermediateFinance.ts';
import { economyOf, gameClock, insuranceOf, pendingCrises, yearAt, type IntermediateState } from './intermediateState.ts';
import { crisisDue, type CrisisRecord, type CrisisType, type InsurancePolicy, type InsuranceState, type PremiumBreakdown } from './insuranceState.ts';
import { ownedBy } from './selectors.ts';
import type { GameState, PlayerState } from './types.ts';

/**
 * Property insurance and global crises: the read-only views the screens show and the engine
 * validates against, and the state transitions. Like the rest of Capital Mode, every
 * transition works on the action's Draft, so the premium, the policy, the crisis record, the claim
 * and the events of one action commit together or not at all.
 *
 * The rules, in one place (the values are INTERMEDIATE_RULES.insurance):
 *   - A policy insures one or more of its buyer's properties (a portfolio) for one coverage period of
 *     36 spaces of average movement. It pays for every covered crisis on those properties in that period,
 *     each loss less the deductible, until it has paid `payoutLimit` in total. Claims are automatic.
 *   - Premium = base premium of the financial year × properties, less the discounts, which add up and are
 *     capped together at `maxTotalDiscountPercent` (insuranceQuote):
 *       portfolio   5% for each property after the first, up to 25%;
 *       loyalty     renewals only — 20% for a renewal line first bought in Year 1, 10% for Year 2;
 *       no-claim    renewals only — 10% per claim-free period in a row, up to 30%.
 *     A claim never removes the loyalty discount; it makes its period not claim-free, which resets the run.
 *   - Renewal is optional, opens once the period's last crisis checkpoint has passed (so whether the period was
 *     claim-free is settled) and closes `renewalGraceSpaces` after the period ends. Renewed early, the new
 *     period starts when the old one ends; after it ended, it starts at once. A policy is renewed once at most.
 *   - A policy is never cancelled or refunded: it runs to the end of its period. A property its buyer parts
 *     with (sale, trade, seizure, estate) leaves the policy for good; the new owner gets no cover; claims
 *     already paid and the remaining limit are unchanged.
 *
 * A Classic game — and a Capital game that started before insurance existed — has no
 * insurance state, and nothing in this file does anything for it.
 */

const INS = IR.insurance;

type Clocked = Pick<IntermediateState, 'playerCount'>;
type InsuranceView = Pick<GameState, 'properties' | 'players' | 'status' | 'mode' | 'intermediate'>;

// ---------------------------------------------------------------------------
// Prices and the schedule
// ---------------------------------------------------------------------------

/** The base premium for one property in `year`: ₹250 in Year 1, +₹50 a year, never above ₹450. */
export function premiumForYear(year: number): number {
  return Math.min(INS.premiumMax, INS.premiumYear1 + Math.max(0, year - 1) * INS.premiumStepPerYear);
}

/** Portfolio discount for insuring `properties` under one policy: 5% for each after the first, up to 25%. */
export function portfolioPercent(properties: number): number {
  return Math.min(INS.portfolioMaxPercent, Math.max(0, properties - 1) * INS.portfolioStepPercent);
}

/** Early-buyer loyalty discount of a renewal line first bought in `entryYear`. */
export function loyaltyPercent(entryYear: number): number {
  return INS.loyaltyPercentByEntryYear[entryYear - 1] ?? 0;
}

/** No-claim discount after `periods` claim-free coverage periods in a row: 10% each, up to 30%. */
export function noClaimPercent(periods: number): number {
  return Math.min(INS.noClaimMaxPercent, Math.max(0, periods) * INS.noClaimStepPercent);
}

/** Claim-free periods that still count towards the discount (more than this adds nothing). */
const NO_CLAIM_PERIODS_MAX = INS.noClaimStepPercent > 0 ? Math.ceil(INS.noClaimMaxPercent / INS.noClaimStepPercent) : 0;

export interface QuoteInput {
  year: number;
  properties: number;
  /** A renewal only: the year its line was first bought in, and its claim-free periods in a row. */
  renewal?: { entryYear: number; noClaimPeriods: number };
}

/**
 * THE premium calculation — purchases, portfolios and renewals all come through here, on the server and on
 * the screens alike. Discounts are percentages of the gross premium; they add up and their total is capped.
 */
export function insuranceQuote({ year, properties, renewal }: QuoteInput): PremiumBreakdown {
  const basePremium = premiumForYear(year);
  const grossPremium = basePremium * properties;
  const portfolio = portfolioPercent(properties);
  const loyalty = renewal ? loyaltyPercent(renewal.entryYear) : 0;
  const noClaim = renewal ? noClaimPercent(renewal.noClaimPeriods) : 0;
  const discountPercent = Math.min(INS.maxTotalDiscountPercent, portfolio + loyalty + noClaim);
  return {
    basePremium,
    properties,
    grossPremium,
    portfolioPercent: portfolio,
    loyaltyPercent: loyalty,
    noClaimPercent: noClaim,
    discountPercent,
    premium: Math.round((grossPremium * (100 - discountPercent)) / 100),
  };
}

/** Whether insurance pays for this type of crisis. */
export function isCoveredCrisis(type: CrisisType): boolean {
  return (INS.coveredCrises as readonly CrisisType[]).includes(type);
}

/** The covered crisis types in words, for the screens. */
export const COVERED_CRISIS_LABELS: Record<CrisisType, string> = {
  PROPERTY_CRISIS: 'Property crisis (the scheduled crisis bill on an owned property)',
};

/** What insurance never pays for, in words. */
export const NOT_COVERED = 'rent, taxes, cards, Club, jail fines, loans, mortgages, trades or market price moves';

/** What a policy pays towards a covered `loss`: the loss less the deductible, never more than the limit it has left. */
export function claimPayout(policy: Pick<InsurancePolicy, 'payoutLimit' | 'claimedTotal' | 'deductible'>, loss: number): number {
  return Math.max(0, Math.min(loss - policy.deductible, policy.payoutLimit - policy.claimedTotal));
}

/** What a policy can still pay in its coverage period. */
export function remainingCover(policy: Pick<InsurancePolicy, 'payoutLimit' | 'claimedTotal'>): number {
  return Math.max(0, policy.payoutLimit - policy.claimedTotal);
}

/** Game-clock length of a coverage period: every starting player moving 36 spaces on average. */
export function coverageLength(eco: Clocked): number {
  return Math.max(1, eco.playerCount) * INS.coverageSpaces;
}

/** Game clock of crisis checkpoint `n` (1-based): 18 spaces of average movement, then every 36. */
export function crisisCheckpointClock(eco: Clocked, checkpoint: number): number {
  return Math.max(1, eco.playerCount) * (INS.firstCrisisSpaces + (checkpoint - 1) * INS.crisisIntervalSpaces);
}

/** A game-clock point as average spaces moved per player — the counter players read (one decimal at most). */
export function averageSpaces(eco: Clocked, clock: number): number {
  return Math.round((clock * 10) / Math.max(1, eco.playerCount)) / 10;
}

/** The clock point of the next crisis, or null when this game has no insurance. */
export function nextCrisisClock(eco: IntermediateState): number | null {
  return eco.insurance ? crisisCheckpointClock(eco, eco.insurance.nextCheckpoint) : null;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** Whether `policy` covers `key` for its buyer at clock point `at`: running, in its period, listed, and still the buyer's. */
export function policyCovers(state: Pick<GameState, 'properties'>, policy: InsurancePolicy, key: PropertyKey, at: number): boolean {
  return (
    policy.status === 'ACTIVE' &&
    at >= policy.startClock &&
    at < policy.expiryClock &&
    policy.propertyKeys.includes(key) &&
    state.properties[key]?.ownerId === policy.ownerId
  );
}

/** Whether a policy protects anything at clock point `at`. */
export function policyInForce(state: Pick<GameState, 'properties'>, policy: InsurancePolicy, at: number): boolean {
  return policy.propertyKeys.some((key) => policyCovers(state, policy, key, at));
}

/** The policy protecting a property for its current owner right now, or null. */
export function activePolicyFor(state: InsuranceView, key: PropertyKey): InsurancePolicy | null {
  const eco = economyOf(state);
  if (!eco?.insurance) return null;
  const clock = gameClock(eco);
  return eco.insurance.policies.find((p) => policyCovers(state, p, key, clock)) ?? null;
}

/** The running policies (in force now or starting later) of `ownerId` that list `key`. */
function heldPolicies(ins: InsuranceState, ownerId: string, key: PropertyKey): InsurancePolicy[] {
  return ins.policies.filter((p) => p.status === 'ACTIVE' && p.ownerId === ownerId && p.propertyKeys.includes(key));
}

/**
 * How a policy stands today.
 * IN_FORCE  protecting its properties now.     UPCOMING  a renewal whose period has not started yet.
 * EXPIRED   its period ran out.                ENDED     every property it insured left its buyer's hands.
 * CLAIMED   a single-claim policy from before the redesign, used up.
 */
export type PolicyStanding = 'IN_FORCE' | 'UPCOMING' | 'EXPIRED' | 'ENDED' | 'CLAIMED';

export function policyStanding(state: InsuranceView, policy: InsurancePolicy): PolicyStanding {
  if (policy.status === 'CLAIMED' || policy.status === 'ENDED') return policy.status;
  const eco = economyOf(state);
  if (policy.status === 'EXPIRED' || !eco) return 'EXPIRED';
  const clock = gameClock(eco);
  if (clock >= policy.expiryClock) return 'EXPIRED';
  return clock < policy.startClock ? 'UPCOMING' : 'IN_FORCE';
}

/** Spaces of average movement a policy has left, rounded up (0 once it has ended). */
export function policySpacesLeft(eco: IntermediateState, policy: InsurancePolicy): number {
  return Math.max(0, Math.ceil((policy.expiryClock - gameClock(eco)) / Math.max(1, eco.playerCount)));
}

export interface PropertyInsurance {
  /** The policy in force for the current owner, if any. */
  active: InsurancePolicy | null;
  /** The current owner's most recent policy listing this property, whatever became of it. */
  latest: InsurancePolicy | null;
  /** What a new single-property policy bought now would cost. */
  premium: number;
  year: number;
}

/** A property's insurance as the deed shows it. Null when this game has no insurance. */
export function propertyInsurance(state: InsuranceView, key: PropertyKey): PropertyInsurance | null {
  const eco = economyOf(state);
  if (!eco?.insurance) return null;
  const ownerId = state.properties[key]?.ownerId ?? null;
  const own = eco.insurance.policies.filter((p) => p.ownerId === ownerId && p.boughtKeys.includes(key));
  return { active: activePolicyFor(state, key), latest: own[own.length - 1] ?? null, premium: insuranceQuote({ year: eco.year, properties: 1 }).premium, year: eco.year };
}

/** Why this player can't insure `keys` under one new policy right now (price aside), or null. */
function coverBlocker(state: InsuranceView, playerId: string, keys: readonly PropertyKey[]): string | null {
  const eco = economyOf(state);
  if (!eco) return 'Property insurance is only available in Capital Mode.';
  if (!eco.insurance) return 'This game started before property insurance existed.';
  if (state.status !== 'ACTIVE') return state.status === 'PAUSED' ? 'Game is paused.' : 'Game is not running.';
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'ACTIVE') return 'You are out of the game.';
  if (keys.length === 0) return 'Choose a property to insure.';
  if (new Set(keys).size !== keys.length) return 'A property can only be insured once.';
  const crisis = pendingCrises(state)[0];
  if (crisis) return crisis.ownerId === playerId ? 'Settle your crisis bill first.' : 'A crisis bill must be settled before play continues.';
  for (const key of keys) {
    if (state.properties[key]?.ownerId !== playerId) return "You don't own this property.";
    const held = heldPolicies(eco.insurance, playerId, key)[0];
    if (held) {
      const name = keys.length > 1 ? `${getDeed(key).name} is already insured` : 'Already insured';
      return gameClock(eco) < held.startClock ? `${name} — its renewal is booked.` : `${name} — ${policySpacesLeft(eco, held)} spaces of cover left.`;
    }
  }
  return null;
}

/** Why this player can't insure this one property right now, or null. The engine runs it; the screens show the same answer. */
export function insureBlocker(state: InsuranceView, playerId: string, key: PropertyKey): string | null {
  return insureAllBlocker(state, playerId, [key]);
}

/** Why this player can't insure all of `keys` under one portfolio policy right now, or null. */
export function insureAllBlocker(state: InsuranceView, playerId: string, keys: readonly PropertyKey[]): string | null {
  if (keys.length === 0 && economyOf(state)?.insurance) return 'Every property you own is already insured.';
  const why = coverBlocker(state, playerId, keys);
  if (why) return why;
  const eco = economyOf(state)!;
  const { premium } = insuranceQuote({ year: eco.year, properties: keys.length });
  const player = state.players.find((p) => p.id === playerId)!;
  if (player.balance < premium) {
    return keys.length === 1
      ? `Not enough money — the premium is ${formatINR(premium)}.`
      : `Not enough money — insuring ${keys.length} properties costs ${formatINR(premium)}.`;
  }
  return null;
}

function failWith(why: string): never {
  fail(why.startsWith('Not enough') ? 'INSUFFICIENT_FUNDS' : why.startsWith("You don't own") ? 'NOT_OWNER' : 'INSURANCE_NOT_ALLOWED', why);
}

/**
 * Buys one policy covering every property in `keys` (one property, or a portfolio). The price is the
 * server's (insuranceQuote for this financial year); `expectedPremium` only proves the player confirmed
 * that same total. Cash and policy change together: a refusal leaves both untouched.
 */
export function buyInsurance(d: Draft, actor: PlayerState, keys: readonly PropertyKey[], expectedPremium: number): InsurancePolicy {
  const why = insureAllBlocker(d.state, actor.id, keys);
  if (why) failWith(why);
  const eco = economyOf(d.state)!;
  const ins = eco.insurance!;
  const pricing = insuranceQuote({ year: eco.year, properties: keys.length });
  // The price the player confirmed must be the price they pay.
  if (pricing.premium !== expectedPremium) {
    fail('STALE_STATE', `The premium is now ${formatINR(pricing.premium)} (Year ${eco.year}). Review it and confirm again.`);
  }
  const clock = gameClock(eco);
  const policy = newPolicy(d, eco, actor.id, [...keys], pricing, clock, null, eco.year, 0);
  ins.policies.push(policy);
  const names = names_(keys);
  d.transfer({ type: 'INSURANCE_PREMIUM', from: actor.id, to: null, amount: pricing.premium, propertyKey: keys[0]!, memo: `Insurance premium (${names})` });
  for (const key of keys) forgetUndoFor(d, key);
  d.event('INSURANCE_PURCHASED', actor.id, `${actor.name} insured ${names} for ${formatINR(pricing.premium)}`, {
    policyId: policy.id,
    propertyKey: keys[0],
    propertyKeys: [...keys],
    premium: pricing.premium,
    year: eco.year,
    startClock: policy.startClock,
    expiryClock: policy.expiryClock,
    payoutLimit: policy.payoutLimit,
  });
  return policy;
}

const names_ = (keys: readonly PropertyKey[]) => keys.map((k) => getDeed(k).name).join(', ');

function newPolicy(
  d: Draft,
  eco: IntermediateState,
  ownerId: string,
  keys: PropertyKey[],
  pricing: PremiumBreakdown,
  startClock: number,
  renewalOf: string | null,
  entryYear: number,
  noClaimPeriods: number,
): InsurancePolicy {
  return {
    id: d.ctx.newId(),
    ownerId,
    propertyKeys: keys,
    boughtKeys: [...keys],
    purchaseYear: eco.year,
    premiumPaid: pricing.premium,
    pricing,
    startClock,
    expiryClock: startClock + coverageLength(eco),
    payoutLimit: INS.payoutLimit,
    deductible: INS.deductible,
    claimedTotal: 0,
    renewalOf,
    entryYear,
    noClaimPeriods,
    status: 'ACTIVE',
    createdAt: d.ctx.now,
    closedAt: null,
  };
}

/** The properties this player owns that no policy of theirs is protecting or about to protect, in board-data order. */
export function uninsuredProperties(state: InsuranceView, playerId: string): PropertyKey[] {
  const ins = insuranceOf(state);
  if (!ins) return [];
  return ownedBy(state, playerId).filter((key) => heldPolicies(ins, playerId, key).length === 0);
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

/**
 * When a policy can be renewed, on the game clock: from the last crisis checkpoint inside its period (once
 * that has passed, whether the period was claim-free is settled) until `renewalGraceSpaces` after it ended.
 */
export function renewalWindow(eco: Clocked, policy: Pick<InsurancePolicy, 'startClock' | 'expiryClock'>): { opensAt: number; closesAt: number } {
  let opensAt = policy.startClock;
  for (let n = 1; crisisCheckpointClock(eco, n) < policy.expiryClock; n += 1) {
    const at = crisisCheckpointClock(eco, n);
    if (at >= policy.startClock) opensAt = at;
  }
  return { opensAt, closesAt: policy.expiryClock + Math.max(1, eco.playerCount) * INS.renewalGraceSpaces };
}

/** The policy that renews `policy`, if it has been renewed. */
export function renewalOf(ins: InsuranceState, policy: InsurancePolicy): InsurancePolicy | null {
  return ins.policies.find((p) => p.renewalOf === policy.id) ?? null;
}

/** Claim-free periods in a row a renewal of `policy` would be priced with: one more if its period paid nothing, else none. */
export function renewalNoClaimPeriods(policy: Pick<InsurancePolicy, 'claimedTotal' | 'noClaimPeriods'>): number {
  return policy.claimedTotal === 0 ? Math.min(NO_CLAIM_PERIODS_MAX, policy.noClaimPeriods + 1) : 0;
}

export interface RenewalOffer {
  policy: InsurancePolicy;
  pricing: PremiumBreakdown;
  /** The new period, on the game clock. */
  startClock: number;
  expiryClock: number;
  noClaimPeriods: number;
}

/** What renewing this policy now would cost and cover (whether or not it is allowed right now). Null when there is nothing to renew. */
export function renewalOffer(state: InsuranceView, policy: InsurancePolicy): RenewalOffer | null {
  const eco = economyOf(state);
  if (!eco?.insurance || policy.propertyKeys.length === 0) return null;
  const noClaimPeriods = renewalNoClaimPeriods(policy);
  const pricing = insuranceQuote({ year: eco.year, properties: policy.propertyKeys.length, renewal: { entryYear: policy.entryYear, noClaimPeriods } });
  const startClock = Math.max(gameClock(eco), policy.expiryClock);
  return { policy, pricing, startClock, expiryClock: startClock + coverageLength(eco), noClaimPeriods };
}

/** Why this player can't renew this policy right now, or null. */
export function renewalBlocker(state: InsuranceView, playerId: string, policyId: string): string | null {
  const eco = economyOf(state);
  if (!eco) return 'Property insurance is only available in Capital Mode.';
  const ins = eco.insurance;
  if (!ins) return 'This game started before property insurance existed.';
  const policy = ins.policies.find((p) => p.id === policyId);
  if (!policy || policy.ownerId !== playerId) return 'Policy not found.';
  if (state.status !== 'ACTIVE') return state.status === 'PAUSED' ? 'Game is paused.' : 'Game is not running.';
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.status !== 'ACTIVE') return 'You are out of the game.';
  if (renewalOf(ins, policy)) return 'This policy has already been renewed.';
  if (policy.status === 'ENDED' || policy.propertyKeys.length === 0) return 'This policy no longer insures any property.';
  if (policy.status === 'CLAIMED') return 'This policy was used up. Insure the property again instead.';
  const crisis = pendingCrises(state)[0];
  if (crisis) return crisis.ownerId === playerId ? 'Settle your crisis bill first.' : 'A crisis bill must be settled before play continues.';
  const clock = gameClock(eco);
  const { opensAt, closesAt } = renewalWindow(eco, policy);
  if (clock < opensAt) return `Renewal opens after this period's crisis, in ${Math.ceil((opensAt - clock) / Math.max(1, eco.playerCount))} spaces.`;
  if (clock >= closesAt) return 'Too late to renew — insure the properties again as a new policy.';
  for (const key of policy.propertyKeys) {
    if (state.properties[key]?.ownerId !== playerId) return `You no longer own ${getDeed(key).name}.`;
    if (heldPolicies(ins, playerId, key).some((p) => p.id !== policy.id)) return `${getDeed(key).name} is already insured by another policy.`;
  }
  const offer = renewalOffer(state, policy)!;
  if (player.balance < offer.pricing.premium) return `Not enough money — the renewal premium is ${formatINR(offer.pricing.premium)}.`;
  return null;
}

/**
 * Renews a policy for another coverage period, for the properties it still insures, at the server's price.
 * Optional and never automatic: only the policy's buyer asks for it, confirming `expectedPremium`. The renewal
 * is a new policy linked to the old one (renewalOf), so the old period keeps its own claims and the new one
 * starts with the full limit; a second request for the same policy is refused.
 */
export function renewInsurance(d: Draft, actor: PlayerState, policyId: string, expectedPremium: number): InsurancePolicy {
  const why = renewalBlocker(d.state, actor.id, policyId);
  if (why === 'Policy not found.') fail('NOT_FOUND', why);
  if (why) failWith(why);
  const eco = economyOf(d.state)!;
  const ins = eco.insurance!;
  const old = ins.policies.find((p) => p.id === policyId)!;
  const offer = renewalOffer(d.state, old)!;
  if (offer.pricing.premium !== expectedPremium) {
    fail('STALE_STATE', `The renewal premium is now ${formatINR(offer.pricing.premium)}. Review it and confirm again.`);
  }
  const policy = newPolicy(d, eco, actor.id, [...old.propertyKeys], offer.pricing, offer.startClock, old.id, old.entryYear, offer.noClaimPeriods);
  ins.policies.push(policy);
  const names = names_(policy.propertyKeys);
  d.transfer({ type: 'INSURANCE_PREMIUM', from: actor.id, to: null, amount: offer.pricing.premium, propertyKey: policy.propertyKeys[0]!, memo: `Insurance renewal (${names})` });
  for (const key of policy.propertyKeys) forgetUndoFor(d, key);
  d.event('INSURANCE_RENEWED', actor.id, `${actor.name} renewed the insurance on ${names} for ${formatINR(offer.pricing.premium)}`, {
    policyId: policy.id,
    renewalOf: old.id,
    propertyKeys: [...policy.propertyKeys],
    premium: offer.pricing.premium,
    loyaltyPercent: offer.pricing.loyaltyPercent,
    noClaimPercent: offer.pricing.noClaimPercent,
    startClock: policy.startClock,
    expiryClock: policy.expiryClock,
  });
  return policy;
}

// ---------------------------------------------------------------------------
// Ownership changes and the end of the game
// ---------------------------------------------------------------------------

export type InsuranceReleaseReason = 'PROPERTY_SOLD' | 'PROPERTY_TRADED' | 'COLLATERAL_SEIZED' | 'RETURNED_TO_BANK';

const RELEASE_WORDS: Record<InsuranceReleaseReason, string> = {
  PROPERTY_SOLD: 'the sale',
  PROPERTY_TRADED: 'the trade',
  COLLATERAL_SEIZED: 'the seizure',
  RETURNED_TO_BANK: 'its return to the bank',
};

/**
 * `key` is leaving `ownerId`'s hands: it leaves every running policy of theirs, for good. The policy protected
 * the seller's ownership and nobody else's, so it does not pass to the new owner and does not revive if the
 * seller gets the property back. Claims already paid and the limit left stay as they were; a policy left with
 * no property is ENDED. No refund. Returns whether any policy changed (the caller then makes the action final:
 * an undo could restore the property but not the cover).
 */
export function releaseInsurance(d: Draft, key: PropertyKey, ownerId: string | null, reason: InsuranceReleaseReason): boolean {
  const ins = insuranceOf(d.state);
  if (!ins || !ownerId) return false;
  let changed = false;
  for (const policy of heldPolicies(ins, ownerId, key)) {
    changed = true;
    policy.propertyKeys = policy.propertyKeys.filter((k) => k !== key);
    if (policy.propertyKeys.length === 0) {
      policy.status = 'ENDED';
      policy.closedAt = d.ctx.now;
    }
    d.event('INSURANCE_ENDED', ownerId, `${d.name(ownerId)}'s insurance on ${getDeed(key).name} ended with ${RELEASE_WORDS[reason]}`, {
      policyId: policy.id,
      propertyKey: key,
      reason,
      propertiesLeft: policy.propertyKeys.length,
    });
  }
  return changed;
}

/** The game is over: every running policy's cover ends with it — no refund, and no payout because it ended. */
export function expireInsuranceAtGameEnd(d: Draft): void {
  for (const policy of insuranceOf(d.state)?.policies ?? []) {
    if (policy.status !== 'ACTIVE') continue;
    policy.status = 'EXPIRED';
    policy.closedAt = d.ctx.now;
  }
}

/** A premium, a crisis bill, an insurance change or an auction sale is never reversed, so earlier actions on that property can no longer be undone around it. */
export function forgetUndoFor(d: Draft, key: PropertyKey): void {
  const touches = (r: GameState['undoStack'][number]) => r.propertyKey === key || r.propertiesAfter.some((p) => p.key === key);
  if (!d.state.undoStack.some(touches)) return;
  d.state.undoStack = d.state.undoStack.filter((r) => !touches(r));
  d.state.undoRequest = null;
}

// ---------------------------------------------------------------------------
// The crisis schedule and claims
// ---------------------------------------------------------------------------

/**
 * Brings the crisis schedule up to date with the clock, inside the dice roll that moved it:
 * every checkpoint the clock has reached is resolved, oldest first, exactly once
 * (`nextCheckpoint` only grows); then policies whose period has run out are closed.
 * Runs after the year and loan checkpoints, so those draw from the RNG in the order they always did.
 */
export function processCrisisCheckpoints(d: Draft, eco: IntermediateState): void {
  const ins = eco.insurance;
  if (!ins) return;
  const clock = gameClock(eco);
  while (crisisCheckpointClock(eco, ins.nextCheckpoint) <= clock) {
    const checkpoint = ins.nextCheckpoint;
    ins.nextCheckpoint += 1;
    if (!ins.crises.some((c) => c.checkpoint === checkpoint)) resolveCrisis(d, eco, ins, checkpoint);
  }
  for (const policy of ins.policies) {
    if (policy.status !== 'ACTIVE' || clock < policy.expiryClock) continue;
    policy.status = 'EXPIRED';
    policy.closedAt = d.ctx.now;
    d.event('INSURANCE_EXPIRED', policy.ownerId, `${d.name(policy.ownerId)}'s insurance on ${names_(policy.propertyKeys)} expired`, {
      policyId: policy.id,
      propertyKey: policy.propertyKeys[0] ?? null,
      propertyKeys: [...policy.propertyKeys],
      claimedTotal: policy.claimedTotal,
    });
  }
}

/**
 * One crisis: the server picks one property among everything the players still in the game own
 * (mortgaged or not) and puts the bill on its owner. If a policy of the owner covers that property at the
 * checkpoint, the claim is made at once: the policy pays the loss less the deductible, up to the limit it
 * has left, and the owner owes only the rest (nothing, when it paid all). Nothing else about the property
 * changes: not its owner, its buildings or its mortgage.
 */
function resolveCrisis(d: Draft, eco: IntermediateState, ins: InsuranceState, checkpoint: number): void {
  const at = crisisCheckpointClock(eco, checkpoint);
  const playing = new Set(d.activePlayers().map((p) => p.id));
  const eligible = PROPERTY_KEYS.filter((k) => {
    const ownerId = d.state.properties[k].ownerId;
    return ownerId !== null && playing.has(ownerId);
  });
  const crisis: CrisisRecord = {
    id: d.ctx.newId(),
    type: 'PROPERTY_CRISIS',
    checkpoint,
    checkpointClock: at,
    year: yearAt(eco, at),
    propertyKey: null,
    ownerId: null,
    mortgaged: false,
    amount: 0,
    covered: 0,
    paid: 0,
    policyId: null,
    status: 'SKIPPED',
    createdAt: d.ctx.now,
    settledAt: d.ctx.now,
  };
  ins.crises.push(crisis);
  // Nobody owns anything: the checkpoint is used up and the schedule carries on unchanged.
  if (eligible.length === 0) return;

  // A single candidate needs no draw; otherwise the server's RNG decides, and never a client.
  const key = eligible.length === 1 ? eligible[0]! : pickFrom(eligible, d.ctx.random);
  const prop = d.state.properties[key];
  const ownerId = prop.ownerId!;
  const deed = getDeed(key);
  crisis.propertyKey = key;
  crisis.ownerId = ownerId;
  crisis.mortgaged = prop.mortgaged;
  crisis.amount = INS.crisisBill;
  forgetUndoFor(d, key);

  const payload = { crisisId: crisis.id, checkpoint, propertyKey: key, ownerId, amount: crisis.amount, mortgaged: prop.mortgaged };
  const policy = isCoveredCrisis('PROPERTY_CRISIS') ? ins.policies.find((p) => p.ownerId === ownerId && policyCovers(d.state, p, key, at)) : undefined;
  // The claim: worked out here from the server's own records, once — the crisis is new, so it has never been claimed.
  const payout = policy ? claimPayout(policy, crisis.amount) : 0;
  if (policy && payout > 0) {
    policy.claimedTotal += payout;
    crisis.policyId = policy.id;
    crisis.covered = payout;
  }
  if (crisis.covered === crisis.amount) {
    crisis.status = 'COVERED';
    d.event('CRISIS_COVERED', ownerId, `Crisis at ${deed.name}! ${d.name(ownerId)}'s insurance paid the ${formatINR(crisis.amount)} bill`, { ...payload, policyId: crisis.policyId, covered: payout });
    return;
  }
  crisis.status = 'PENDING';
  crisis.settledAt = null;
  const due = crisisDue(crisis);
  const message = !policy
    ? `Crisis at ${deed.name}! ${d.name(ownerId)} has no insurance and owes ${formatINR(due)}`
    : payout > 0
      ? `Crisis at ${deed.name}! ${d.name(ownerId)}'s insurance paid ${formatINR(payout)} — its limit — and ${d.name(ownerId)} owes the other ${formatINR(due)}`
      : `Crisis at ${deed.name}! ${d.name(ownerId)}'s insurance has nothing left to pay this period, so ${d.name(ownerId)} owes ${formatINR(due)}`;
  d.event('CRISIS_STRUCK', ownerId, message, { ...payload, policyId: crisis.policyId, covered: payout, due });
}

// ---------------------------------------------------------------------------
// Settling a crisis bill
// ---------------------------------------------------------------------------

/** The pending bill this player must settle first (their oldest), or null. */
export function pendingCrisisOf(state: InsuranceView, playerId: string): CrisisRecord | null {
  return pendingCrises(state).find((c) => c.ownerId === playerId) ?? null;
}

/**
 * Why an action is refused while a crisis bill is unsettled, or null when it may go ahead.
 *
 * Everyone may still pause, resume, leave, vote in an open end-game vote, decline an offer or request, and
 * send money to the player who owes. The player who owes may also pay, and raise money the usual
 * ways: sell a building, sell a property to the bank, mortgage, or take a loan the bank offers.
 * Everything else — rolling, ending a turn, buying, building, trading, insuring, renewing — waits.
 */
export function crisisGate(state: InsuranceView, actorId: string, action: GameAction): string | null {
  const pending = pendingCrises(state);
  const first = pending[0];
  if (!first) return null;
  const mine = pending.find((c) => c.ownerId === actorId);
  switch (action.type) {
    case 'PAUSE_GAME':
    case 'RESUME_GAME':
    case 'CAST_END_VOTE':
    case 'CLOSE_END_VOTE':
    case 'LEAVE_GAME':
    case 'REJECT_TRADE':
    case 'CANCEL_TRADE':
    case 'REJECT_UNDO':
      return null;
    case 'TRANSFER_MONEY':
      if (!mine && pending.some((c) => c.ownerId === action.toPlayerId)) return null;
      break;
    case 'PAY_CRISIS_BILL':
    case 'DECLARE_CRISIS_BANKRUPTCY':
    case 'SELL_BUILDING':
    case 'SELL_PROPERTY':
    case 'MORTGAGE_PROPERTY':
    case 'TAKE_INTERMEDIATE_LOAN':
      if (mine) return null;
      break;
    default:
      break;
  }
  if (mine) return `Settle your ${formatINR(crisisDue(mine))} crisis bill first.`;
  const owner = state.players.find((p) => p.id === first.ownerId)?.name ?? 'A player';
  return `Waiting for ${owner} to settle a ${formatINR(crisisDue(first))} crisis bill.`;
}

function ownPendingCrisis(d: Draft, actor: PlayerState, crisisId: string): CrisisRecord {
  const crisis = insuranceOf(d.state)?.crises.find((c) => c.id === crisisId);
  if (!crisis || crisis.ownerId !== actor.id) fail('NOT_FOUND', 'Crisis bill not found.');
  // A retry that arrives after the bill was settled finds nothing to pay: no second deduction.
  if (crisis.status !== 'PENDING') fail('INVALID_PHASE', 'This crisis bill is already settled.');
  return crisis;
}

/** Pays what is left of a pending crisis bill in full. Payment and settlement are one step of one action. */
export function payCrisisBill(d: Draft, actor: PlayerState, crisisId: string): void {
  const crisis = ownPendingCrisis(d, actor, crisisId);
  const due = crisisDue(crisis);
  if (actor.balance < due) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — you need ${formatINR(due)}. Mortgage, sell or take a loan.`);
  }
  const name = crisis.propertyKey ? getDeed(crisis.propertyKey).name : 'a property';
  d.transfer({ type: 'CRISIS_PAYMENT', from: actor.id, to: null, amount: due, propertyKey: crisis.propertyKey, memo: `Crisis bill (${name})` });
  crisis.paid += due;
  crisis.status = 'PAID';
  crisis.settledAt = d.ctx.now;
  d.event('CRISIS_SETTLED', actor.id, `${actor.name} paid the ${formatINR(due)} crisis bill for ${name}`, {
    crisisId: crisis.id,
    checkpoint: crisis.checkpoint,
    propertyKey: crisis.propertyKey,
    amount: crisis.amount,
    covered: crisis.covered,
  });
}

/** The ways this player could still raise money for a crisis bill, in words (estate.raiseFundsOptions). Empty = nothing left to try. */
export function crisisRecoveryOptions(state: GameState, playerId: string): string[] {
  return raiseFundsOptions(state, playerId);
}

/**
 * Why this player may not go bankrupt over a crisis bill right now, or null. The game's one bankruptcy
 * rule (estate.bankruptcyBlocker): lacking the cash is not enough, and borrowing is never required.
 */
export function crisisBankruptcyBlocker(state: GameState, playerId: string, crisis: CrisisRecord): string | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 'You are not in this game.';
  if (player.balance >= crisisDue(crisis)) return 'You can afford this bill.';
  return bankruptcyBlockerNow(state, playerId);
}

/** Validates a bankruptcy over `crisisId` and returns the bill. The reducer then runs the game's own bankruptcy. */
export function assertCrisisBankruptcy(d: Draft, actor: PlayerState, crisisId: string): CrisisRecord {
  const crisis = ownPendingCrisis(d, actor, crisisId);
  const why = crisisBankruptcyBlocker(d.state, actor.id, crisis);
  if (why) fail('INVALID_PHASE', why);
  return crisis;
}

/**
 * Closes every pending bill when the game is ending: the bank takes what cash there is towards each
 * bill. Anything it could not collect stays on record as UNPAID and counts against that player's net
 * worth, so no bill is skipped before the winner is decided. (A player who goes bankrupt or leaves
 * settles their bills with the rest of their estate: estate.settleEstate.) What insurance already paid stays paid.
 */
export function closePendingCrises(d: Draft): void {
  for (const crisis of pendingCrises(d.state)) {
    const owner = d.state.players.find((p) => p.id === crisis.ownerId);
    const name = crisis.propertyKey ? getDeed(crisis.propertyKey).name : 'a property';
    const part = Math.min(crisisDue(crisis), owner?.balance ?? 0);
    if (owner && part > 0) {
      d.transfer({ type: 'CRISIS_PAYMENT', from: owner.id, to: null, amount: part, propertyKey: crisis.propertyKey, memo: `Crisis bill (${name})` });
    }
    crisis.paid += part;
    crisis.status = crisisDue(crisis) === 0 ? 'PAID' : 'UNPAID';
    crisis.settledAt = d.ctx.now;
    const who = d.name(crisis.ownerId);
    d.event(
      crisis.status === 'PAID' ? 'CRISIS_SETTLED' : 'CRISIS_UNPAID',
      crisis.ownerId,
      crisis.status === 'PAID'
        ? `${who} paid the ${formatINR(crisis.paid)} crisis bill for ${name}`
        : `${who} left ${formatINR(crisisDue(crisis))} of the crisis bill for ${name} unpaid`,
      { crisisId: crisis.id, checkpoint: crisis.checkpoint, propertyKey: crisis.propertyKey, amount: crisis.amount, covered: crisis.covered, paid: crisis.paid },
    );
  }
}
