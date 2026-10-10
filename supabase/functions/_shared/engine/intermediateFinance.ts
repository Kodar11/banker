import { INTERMEDIATE_RULES as IR, type LoanProductKey } from './intermediateConfig.ts';

/**
 * Intermediate Mode's financial maths. Pure functions of their arguments: no game state, no
 * clock, no randomness of their own (a `random` source is passed in where one is needed).
 *
 * Money is whole rupees and every rate is a whole percent, so everything here is exact integer
 * arithmetic (BigInt where a product could pass 2^53) with one rounding rule: half up.
 */

const big = (n: number): bigint => BigInt(Math.trunc(n));
const ZERO = BigInt(0);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);

function pow(base: bigint, exponent: number): bigint {
  let out = BigInt(1);
  for (let i = 0; i < exponent; i += 1) out *= base;
  return out;
}

/** num / den rounded half up, for non-negative num and positive den. */
function divRound(num: bigint, den: bigint): number {
  return Number((num * TWO + den) / (den * TWO));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundToNearest(value: number, step: number): number {
  return divRound(big(value), big(step)) * step;
}

export function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

// ---------------------------------------------------------------------------
// Inflation
// ---------------------------------------------------------------------------

/**
 * What a nominal amount is worth in Year-1 money after `years` financial years of fixed
 * inflation: V / (1 + i)^n, to the nearest rupee.
 */
export function realValue(nominal: number, years: number, ratePercent: number = IR.inflation.ratePercent): number {
  if (years <= 0 || nominal <= 0) return Math.max(0, nominal);
  return divRound(big(nominal) * pow(HUNDRED, years), pow(HUNDRED + big(ratePercent), years));
}

// ---------------------------------------------------------------------------
// Property market
// ---------------------------------------------------------------------------

/** One year's market change applied to a value: nearest ₹100, never below the minimum. */
export function applyMarketChange(value: number, changePercent: number): number {
  const moved = divRound(big(value) * (HUNDRED + big(changePercent)), HUNDRED);
  return Math.max(IR.market.minValue, roundToNearest(moved, IR.market.roundTo));
}

/** Draws one annual change from the configured distribution. `random` is uniform in [0, 1). */
export function pickMarketChange(random: () => number): number {
  const roll = clamp(random(), 0, 0.999999) * 100;
  let cumulative = 0;
  for (const change of IR.market.changes) {
    cumulative += change.weight;
    if (roll < cumulative) return change.percent;
  }
  return IR.market.changes[IR.market.changes.length - 1]!.percent;
}

/** Uniform pick from a list. */
export function pickFrom<T>(options: readonly T[], random: () => number): T {
  const index = clamp(Math.floor(random() * options.length), 0, options.length - 1);
  return options[index]!;
}

/**
 * The labelled projection: today's value compounding at the property's expected trend for
 * `years` years. An estimate from the trend alone — it knows nothing about future market changes.
 */
export function projectedValue(value: number, trendPercent: number, years: number = IR.market.projectionYears): number {
  const grown = divRound(big(value) * pow(HUNDRED + big(trendPercent), years), pow(HUNDRED, years));
  return Math.max(IR.market.minValue, roundToNearest(grown, IR.market.roundTo));
}

/** The most a property can secure: a share of its market value, rounded down to ₹500. */
export function collateralLimit(marketValue: number): number {
  return floorTo(Math.floor((marketValue * IR.loans.collateralAdvancePercent) / 100), IR.loans.collateralRoundTo);
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------

export function clampScore(score: number): number {
  return clamp(Math.round(score), IR.credit.min, IR.credit.max);
}

export function creditBand(score: number): { min: number; max: number; label: string; adjustPercent: number } {
  const s = clampScore(score);
  return IR.credit.bands.find((b) => s >= b.min && s <= b.max) ?? IR.credit.bands[IR.credit.bands.length - 1]!;
}

export function clampRate(ratePercent: number): number {
  return clamp(ratePercent, IR.rates.minPercent, IR.rates.maxPercent);
}

/** The personalised annual rate of a new offer: base rate + credit adjustment, within the floor and ceiling. */
export function offeredRate(product: LoanProductKey, score: number): { marketRatePercent: number; creditAdjustmentPercent: number; ratePercent: number } {
  const marketRatePercent = IR.loans.products[product].baseRatePercent;
  const creditAdjustmentPercent = creditBand(score).adjustPercent;
  return { marketRatePercent, creditAdjustmentPercent, ratePercent: clampRate(marketRatePercent + creditAdjustmentPercent) };
}

/** A Flexible-rate loan after one annual review: the market component moves, the signed credit adjustment stays. */
export function reviewedRate(marketRatePercent: number, movePercent: number, creditAdjustmentPercent: number): { marketRatePercent: number; ratePercent: number } {
  const market = clampRate(marketRatePercent + movePercent);
  return { marketRatePercent: market, ratePercent: clampRate(market + creditAdjustmentPercent) };
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

/** One year of interest on a principal. */
export function annualInterest(principal: number, ratePercent: number): number {
  return divRound(big(principal) * big(ratePercent), HUNDRED);
}

/**
 * The standard level annual payment for an amortizing loan:
 *   A = P·r·(1+r)^n / ((1+r)^n − 1)
 * computed exactly with r as a whole percent, to the nearest rupee.
 */
export function annualInstallment(principal: number, ratePercent: number, payments: number): number {
  if (principal <= 0 || payments <= 0) return 0;
  if (ratePercent <= 0) return divRound(big(principal), big(payments));
  const growth = pow(HUNDRED + big(ratePercent), payments);
  const num = big(principal) * big(ratePercent) * growth;
  const den = HUNDRED * (growth - pow(HUNDRED, payments));
  return den > ZERO ? divRound(num, den) : principal;
}

export interface ScheduleLine {
  principal: number;
  interest: number;
}

/**
 * The repayment schedule for `principal` over `payments` annual installments. Interest each
 * year is charged on the principal still outstanding (never on interest); every installment
 * but the last is the level payment; the last one clears exactly what is left, so the
 * principal parts always add up to `principal`.
 */
export function buildSchedule(principal: number, ratePercent: number, payments: number): ScheduleLine[] {
  const level = annualInstallment(principal, ratePercent, payments);
  const lines: ScheduleLine[] = [];
  let balance = principal;
  for (let i = 1; i <= payments; i += 1) {
    const interest = annualInterest(balance, ratePercent);
    const part = i === payments ? balance : clamp(level - interest, 0, balance);
    lines.push({ principal: part, interest });
    balance -= part;
  }
  return lines;
}

export function scheduleTotal(lines: readonly ScheduleLine[]): { principal: number; interest: number; total: number } {
  const principal = lines.reduce((s, l) => s + l.principal, 0);
  const interest = lines.reduce((s, l) => s + l.interest, 0);
  return { principal, interest, total: principal + interest };
}

/**
 * Interest that has built up on `principal` part-way through a loan year: the annual interest,
 * pro rata for the share of the year that has passed on the game clock.
 */
export function accruedInterest(principal: number, ratePercent: number, elapsed: number, yearLength: number): number {
  if (principal <= 0 || yearLength <= 0) return 0;
  const done = clamp(elapsed, 0, yearLength);
  return divRound(big(principal) * big(ratePercent) * big(done), HUNDRED * big(yearLength));
}

/**
 * Secured-loan default: the property's market value goes against what is owed. Anything left
 * over belongs to the borrower; anything still owed stays owed.
 */
export function settleCollateral(marketValue: number, owed: number): { applied: number; surplus: number; remaining: number } {
  const applied = Math.min(Math.max(0, marketValue), Math.max(0, owed));
  return { applied, surplus: Math.max(0, marketValue - applied), remaining: Math.max(0, owed - applied) };
}

/** debtRatio = outstanding loan principal / max(net asset value, 1). */
export function debtRatio(outstandingPrincipal: number, netAssetValue: number): number {
  return outstandingPrincipal / Math.max(netAssetValue, 1);
}
