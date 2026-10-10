import type { PropertyKey } from './businessBoard.ts';
import { INTERMEDIATE_RULES as IR, type CreditEventType, type LoanProductKey } from './intermediateConfig.ts';

/**
 * Intermediate Mode state. Lives in GameState.intermediate (one JSON document per game, written
 * in the same transaction as everything else) and is null for Classic games and before
 * an Intermediate game starts. Only the server writes it.
 */

/** The ruleset of a game: chosen by the host at creation, never changed afterwards. */
export type GameMode = 'classic' | 'intermediate';
export const GAME_MODES: readonly GameMode[] = ['classic', 'intermediate'];

/** A record without a mode (a game stored before modes existed) is a Classic game. */
export function normalizeGameMode(raw: unknown): GameMode {
  return raw === 'intermediate' ? 'intermediate' : 'classic';
}

/**
 * SCHEDULED → DUE (reached its due point) → PAID (in time)
 *                 └→ OVERDUE (payment window passed) → CAUGHT_UP (paid within grace)
 *                                └→ DEFAULTED (grace passed; the loan defaulted)
 */
export type InstallmentStatus = 'SCHEDULED' | 'DUE' | 'PAID' | 'OVERDUE' | 'CAUGHT_UP' | 'DEFAULTED';

export interface Installment {
  /** 1-based. */
  index: number;
  /** Game-clock point (see IntermediateState.movement) at which this installment falls due. */
  dueAt: number;
  principal: number;
  interest: number;
  status: InstallmentStatus;
  /** Game clock when it was paid. */
  paidAt: number | null;
}

/**
 * ACTIVE     being repaid on its schedule.
 * REPAID     fully repaid as agreed.
 * DEFAULTED  an installment stayed unpaid through the grace period; `defaultBalance` is still owed.
 * SETTLED    defaulted, and the balance has since been cleared (collateral and/or payments).
 * WRITTEN_OFF the borrower went bankrupt.
 */
export type IntermediateLoanStatus = 'ACTIVE' | 'REPAID' | 'DEFAULTED' | 'SETTLED' | 'WRITTEN_OFF';

export interface RateChange {
  /** Game clock and financial year the new rate took effect. */
  clock: number;
  year: number;
  movePercent: number;
  ratePercent: number;
}

export interface CollateralSettlement {
  propertyKey: PropertyKey;
  /** Market value of the property when it was seized. */
  value: number;
  /** Part of the value used against the debt. */
  applied: number;
  /** Part of the value returned to the borrower. */
  surplus: number;
}

export interface IntermediateLoan {
  id: string;
  playerId: string;
  product: LoanProductKey;
  principal: number;
  /** The contractual annual rate right now (market component + the credit adjustment locked at signing). */
  ratePercent: number;
  /** Market component: the product's base rate; moves yearly for a VARIABLE loan only. */
  marketRatePercent: number;
  /** Credit-score adjustment agreed at signing. Never changes. */
  creditAdjustmentPercent: number;
  rateType: 'FIXED' | 'VARIABLE';
  tenureYears: number;
  /** The property pledged for this loan while the claim is live; null once released or seized. */
  collateralKey: PropertyKey | null;
  /** Game clock and financial year at signing. Installment k is due at originClock + k years. */
  originClock: number;
  originYear: number;
  installments: Installment[];
  status: IntermediateLoanStatus;
  /** After a default: everything still owed, payable in any amounts. 0 otherwise. */
  defaultBalance: number;
  rateHistory: RateChange[];
  /** Early principal repayments, with the interest that had accrued on each. */
  prepayments: { clock: number; year: number; principal: number; interest: number }[];
  settlement: CollateralSettlement | null;
  createdAt: string;
  closedAt: string | null;
}

export interface MarketEntry {
  /** Official current market value. */
  value: number;
  /** Expected long-term trend for this property in this game (projection only). */
  trendPercent: number;
  /** The change applied at the last financial-year transition; null in Year 1. */
  lastChangePercent: number | null;
}

export interface CreditEvent {
  /** Deterministic identity of what happened, e.g. `INSTALLMENT_OVERDUE:<loan>:2`. An id is applied at most once. */
  id: string;
  playerId: string;
  type: CreditEventType;
  delta: number;
  before: number;
  after: number;
  loanId: string | null;
  year: number;
  reason: string;
  createdAt: string;
}

export interface YearReport {
  /** The financial year that just began. */
  year: number;
  changes: Partial<Record<PropertyKey, { percent: number; from: number; to: number }>>;
}

export interface IntermediateState {
  configVersion: string;
  /** Current financial year, starting at 1. Always 1 + floor(clock / yearLength). */
  year: number;
  /** Players who started the game. Fixed: bankruptcies and departures never change it. */
  playerCount: number;
  /** Spaces each starting player has moved by dice, cumulative. Their sum is the game clock. */
  movement: Record<string, number>;
  market: Record<PropertyKey, MarketEntry>;
  /** Credit score per player. */
  credit: Record<string, number>;
  creditEvents: CreditEvent[];
  loans: IntermediateLoan[];
  /** Per player, for the year in progress: had a loan open / had anything overdue or in default. */
  yearFlags: Record<string, { borrowed: boolean; late: boolean }>;
  /** What the last financial-year transition did (drives the announcement on every device). */
  lastReport: YearReport | null;
}

type ModeState = { mode?: GameMode; intermediate?: IntermediateState | null };

/** The live economy of an Intermediate game, or null (Classic game, or not started yet). */
export function economyOf(state: ModeState): IntermediateState | null {
  return state.mode === 'intermediate' && state.intermediate ? state.intermediate : null;
}

export function isIntermediate(state: ModeState): boolean {
  return state.mode === 'intermediate';
}

/** Total spaces moved by all starting players: the shared game clock every loan timeline runs on. */
export function gameClock(eco: Pick<IntermediateState, 'movement'>): number {
  return Object.values(eco.movement).reduce((sum, m) => sum + m, 0);
}

/** Game-clock length of one financial year: every starting player moving 36 spaces on average. */
export function yearLength(eco: Pick<IntermediateState, 'playerCount'>): number {
  return Math.max(1, eco.playerCount) * IR.year.spacesPerYear;
}

/** The financial year a game-clock point falls in (1-based). */
export function yearAt(eco: Pick<IntermediateState, 'playerCount'>, clock: number): number {
  return 1 + Math.floor(clock / yearLength(eco));
}

/** Installments that are owed right now (fallen due and not paid). */
export function unpaidInstallments(loan: IntermediateLoan): Installment[] {
  return loan.installments.filter((i) => i.status === 'DUE' || i.status === 'OVERDUE');
}

/** Principal not yet due on an active loan. */
export function scheduledPrincipal(loan: IntermediateLoan): number {
  return loan.installments.filter((i) => i.status === 'SCHEDULED').reduce((sum, i) => sum + i.principal, 0);
}

/** A loan that still has something to pay. */
export function isOpenLoan(loan: IntermediateLoan): boolean {
  return loan.status === 'ACTIVE' || loan.status === 'DEFAULTED';
}

/**
 * Principal still owed on a loan: what is not yet due, the principal part of what is due,
 * and — after a default — the whole remaining balance.
 */
export function loanOutstandingPrincipal(loan: IntermediateLoan): number {
  if (loan.status === 'DEFAULTED') return loan.defaultBalance;
  if (loan.status !== 'ACTIVE') return 0;
  return scheduledPrincipal(loan) + unpaidInstallments(loan).reduce((sum, i) => sum + i.principal, 0);
}

/** Everything a loan is a liability for today: outstanding principal plus interest already due. */
export function loanLiability(loan: IntermediateLoan): number {
  if (loan.status === 'DEFAULTED') return loan.defaultBalance;
  if (loan.status !== 'ACTIVE') return 0;
  return scheduledPrincipal(loan) + unpaidInstallments(loan).reduce((sum, i) => sum + i.principal + i.interest, 0);
}

export function loansOf(eco: IntermediateState, playerId: string): IntermediateLoan[] {
  return eco.loans.filter((l) => l.playerId === playerId);
}

/** The loan a property is pledged to, if any. A property secures at most one loan. */
export function pledgedLoan(state: ModeState, key: PropertyKey): IntermediateLoan | null {
  const eco = economyOf(state);
  if (!eco) return null;
  return eco.loans.find((l) => l.collateralKey === key && isOpenLoan(l)) ?? null;
}

export function isPledged(state: ModeState, key: PropertyKey): boolean {
  return pledgedLoan(state, key) !== null;
}
