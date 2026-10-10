import type { PropertyKey } from './businessBoard.ts';

/**
 * Property insurance and global crises (Intermediate Mode). Lives in IntermediateState.insurance,
 * so it is written by the server only, under the game lock, in the same transaction as the cash
 * movement, events and version of the action that changed it.
 *
 * All clock values are points on the shared game clock (see intermediateState.gameClock): the sum of
 * every starting player's dice movement. "36 spaces of average movement" is therefore
 * 36 × playerCount on that clock — the same convention the financial year uses.
 */

/**
 * ACTIVE   bought and not yet used. In force while its buyer still owns the property and the clock is before `expiryClock`.
 * CLAIMED  it waived one crisis bill. A policy covers a single crisis: it is spent.
 * EXPIRED  the clock reached `expiryClock` without a claim. No refund.
 */
export type PolicyStatus = 'ACTIVE' | 'CLAIMED' | 'EXPIRED';

export interface InsurancePolicy {
  id: string;
  propertyKey: PropertyKey;
  /** The player who bought it. The policy protects this player's ownership of the property and nobody else's. */
  ownerId: string;
  /** Financial year at purchase: it set the premium. */
  purchaseYear: number;
  premiumPaid: number;
  /** Game clock at purchase. */
  startClock: number;
  /** Game clock at which cover ends: startClock + 36 spaces of average movement. Cover does not include this point. */
  expiryClock: number;
  status: PolicyStatus;
  /** The crisis this policy was used on. */
  claimedCrisisId: string | null;
  createdAt: string;
  closedAt: string | null;
}

/**
 * SKIPPED   no player owned a property at the checkpoint: nothing happened.
 * COVERED   a policy in force waived the bill.
 * PENDING   the owner owes the bill and normal play waits for it.
 * PAID      the owner paid in full.
 * BANKRUPT  the owner could not pay with every way of raising money used up, and went bankrupt.
 * UNPAID    the owner stopped playing (left, or the game ended) owing some of it; `paid` is what was collected.
 */
export type CrisisStatus = 'SKIPPED' | 'COVERED' | 'PENDING' | 'PAID' | 'BANKRUPT' | 'UNPAID';

export interface CrisisRecord {
  id: string;
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
  /** The bill (0 when skipped). */
  amount: number;
  /** What the owner has paid towards it. */
  paid: number;
  /** The policy that waived the bill. */
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
