import type { PropertyKey } from './businessBoard.ts';

/**
 * Property insurance and global crises (Capital Mode). Lives in IntermediateState.insurance,
 * so it is written by the server only, under the game lock, in the same transaction as the cash
 * movement, events and version of the action that changed it.
 *
 * All clock values are points on the shared game clock (see intermediateState.gameClock): the sum of
 * every starting player's dice movement. "36 spaces of average movement" is therefore
 * 36 × playerCount on that clock — the same convention the financial year uses.
 */

/**
 * The crisis types the game has. Insurance pays only for the ones listed in the rules' `coveredCrises`.
 * PROPERTY_CRISIS  the scheduled global crisis that puts a bill on one owned property.
 */
export type CrisisType = 'PROPERTY_CRISIS';

/**
 * ACTIVE   bought (or renewed) and its coverage period has not ended. It pays for covered crises on the
 *          properties still in `propertyKeys` while the clock is in [startClock, expiryClock), up to
 *          `payoutLimit` in total. A renewal is ACTIVE from the moment it is bought, with cover from its startClock.
 * EXPIRED  the coverage period ran out (or the game ended). No refund.
 * ENDED    every property it insured left its buyer's hands (sold, traded, seized, or returned to the bank
 *          when the buyer went bankrupt or left) before the period ran out. No refund.
 * CLAIMED  only on a policy stored before the redesign, when a policy paid for a single crisis and was spent.
 */
export type PolicyStatus = 'ACTIVE' | 'EXPIRED' | 'ENDED' | 'CLAIMED';

/** How a premium was worked out (insurance.insuranceQuote). Fixed when the policy is bought: nothing changes it later. */
export interface PremiumBreakdown {
  /** The financial year's premium for one property. */
  basePremium: number;
  properties: number;
  /** basePremium × properties, before any discount. */
  grossPremium: number;
  portfolioPercent: number;
  loyaltyPercent: number;
  noClaimPercent: number;
  /** The three added together, capped at the rules' maxTotalDiscountPercent. */
  discountPercent: number;
  /** What is charged: grossPremium less discountPercent, in whole rupees. */
  premium: number;
}

export interface InsurancePolicy {
  id: string;
  /** The player who bought it. The policy protects this player's ownership of its properties and nobody else's. */
  ownerId: string;
  /** The properties it insures now. A property leaves the list for good when its buyer parts with it. */
  propertyKeys: PropertyKey[];
  /** The properties it was bought (or renewed) for. Never changes. */
  boughtKeys: PropertyKey[];
  /** Financial year at purchase: it set the base premium. */
  purchaseYear: number;
  premiumPaid: number;
  pricing: PremiumBreakdown;
  /** Game clock at which cover starts (a renewal bought early starts when the period it renews ends). */
  startClock: number;
  /** Game clock at which cover ends: startClock + 36 spaces of average movement. Cover does not include this point. */
  expiryClock: number;
  /** The most this policy pays in total over its coverage period. */
  payoutLimit: number;
  /** What the owner bears of each covered loss. */
  deductible: number;
  /** What it has paid so far (never above payoutLimit). Zero at the end of the period = a claim-free period. */
  claimedTotal: number;
  /** The policy this one renews, or null for a new purchase. A policy is renewed at most once. */
  renewalOf: string | null;
  /** Financial year the first policy of this renewal line was bought: it sets the early-buyer loyalty discount. */
  entryYear: number;
  /** Claim-free coverage periods in a row before this one (drives the no-claim discount it was priced with). */
  noClaimPeriods: number;
  status: PolicyStatus;
  createdAt: string;
  closedAt: string | null;
  /** Policies stored before the redesign only: the crisis the single-claim policy was spent on. */
  claimedCrisisId?: string | null;
}

/**
 * SKIPPED   no player owned a property at the checkpoint: nothing happened.
 * COVERED   a policy in force paid the whole bill.
 * PENDING   the owner owes the bill (or what insurance did not pay of it) and normal play waits for it.
 * PAID      the owner paid their part in full.
 * BANKRUPT  the owner could not pay with every way of raising money used up, and went bankrupt.
 * UNPAID    the owner stopped playing (left, or the game ended) owing some of it; `paid` is what was collected.
 */
export type CrisisStatus = 'SKIPPED' | 'COVERED' | 'PENDING' | 'PAID' | 'BANKRUPT' | 'UNPAID';

export interface CrisisRecord {
  id: string;
  /** Always PROPERTY_CRISIS today (absent on records stored before types were named). */
  type?: CrisisType;
  /** 1-based position on the game's crisis schedule. One record per checkpoint, ever. */
  checkpoint: number;
  /** Game clock of the checkpoint: cover is judged at this point, not at the roll that crossed it. */
  checkpointClock: number;
  /** Financial year the checkpoint fell in. */
  year: number;
  /** The property struck; null when the checkpoint was skipped. */
  propertyKey: PropertyKey | null;
  /** Its owner when it was struck: the bill is theirs whatever happens to the property afterwards. */
  ownerId: string | null;
  /** Whether the property was mortgaged when struck (a crisis never changes that). */
  mortgaged: boolean;
  /** The bill: the loss (0 when skipped). */
  amount: number;
  /** What insurance paid towards it — the claim. Fixed when the crisis is resolved. */
  covered: number;
  /** What the owner has paid towards it. */
  paid: number;
  /** The policy that paid `covered` (null when nothing was paid by insurance). */
  policyId: string | null;
  status: CrisisStatus;
  createdAt: string;
  settledAt: string | null;
}

export interface InsuranceState {
  policies: InsurancePolicy[];
  /** Every checkpoint processed so far, in order. */
  crises: CrisisRecord[];
  /** The next checkpoint to process (1-based). Only ever grows, so a checkpoint is processed at most once. */
  nextCheckpoint: number;
}

export function freshInsurance(): InsuranceState {
  return { policies: [], crises: [], nextCheckpoint: 1 };
}

/** What the owner still has to pay of a crisis bill. */
export function crisisDue(crisis: Pick<CrisisRecord, 'amount' | 'covered' | 'paid'>): number {
  return crisis.amount - (crisis.covered ?? 0) - crisis.paid;
}

/** The single-claim policy limit of the rules before the redesign (one ₹3,000 crisis bill). */
const LEGACY_LIMIT = 3000;

type LegacyPolicy = Partial<InsurancePolicy> & { propertyKey?: PropertyKey; premiumPaid: number; purchaseYear: number };

/**
 * Brings insurance stored before the redesign (one property per policy, one claim, a waived bill) into
 * today's shape, in place, and returns it. A policy keeps its property, term and price; its limit is the one bill
 * it could waive, already used if it was CLAIMED. A COVERED crisis was paid in full by insurance. Running it
 * again changes nothing. The migration that added the new columns backfills the stored rows with the same values.
 */
export function upgradeInsurance(ins: InsuranceState): InsuranceState {
  for (const raw of ins.policies as LegacyPolicy[]) {
    if (Array.isArray(raw.propertyKeys)) continue;
    const keys = raw.propertyKey ? [raw.propertyKey] : [];
    const claimed = raw.status === 'CLAIMED';
    Object.assign(raw, {
      propertyKeys: claimed ? [] : keys,
      boughtKeys: keys,
      pricing: {
        basePremium: raw.premiumPaid,
        properties: 1,
        grossPremium: raw.premiumPaid,
        portfolioPercent: 0,
        loyaltyPercent: 0,
        noClaimPercent: 0,
        discountPercent: 0,
        premium: raw.premiumPaid,
      },
      payoutLimit: LEGACY_LIMIT,
      deductible: 0,
      claimedTotal: claimed ? LEGACY_LIMIT : 0,
      renewalOf: null,
      entryYear: raw.purchaseYear,
      noClaimPeriods: 0,
    });
    delete raw.propertyKey;
  }
  for (const crisis of ins.crises) {
    if (typeof crisis.covered === 'number') continue;
    crisis.covered = crisis.status === 'COVERED' ? crisis.amount : 0;
  }
  return ins;
}
