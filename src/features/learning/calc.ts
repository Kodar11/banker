import { annualInstallment, annualInterest, BUSINESS_MVP_RULES as RULES, clampScore, INTERMEDIATE_RULES as IR, type CreditEventType } from '@/engine/index.ts';

/**
 * The arithmetic behind the Financial Learning stories. Pure functions of their arguments: no
 * game state, no clock, no randomness — the same story always shows the same figures.
 *
 * Rounding rule: money is whole rupees. A derived figure is computed exactly from the story's
 * stated inputs (whole rupees, whole-percent rates) and rounded ONCE, half up, to the nearest
 * rupee. A series (year 1, year 2, …) rounds each year from the original amount, never from the
 * previous year's rounded figure, so the last value always matches the one-step formula.
 */

const big = (n: number): bigint => BigInt(Math.trunc(n));
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

// ---------------------------------------------------------------------------
// Time value of money
// ---------------------------------------------------------------------------

/** FV = PV × (1 + r)^n, to the nearest rupee. `ratePercent` may be negative (a falling value). */
export function futureValue(principal: number, ratePercent: number, years: number): number {
  if (principal <= 0) return 0;
  return divRound(big(principal) * pow(HUNDRED + big(ratePercent), years), pow(HUNDRED, years));
}

/** PV = FV / (1 + r)^n, to the nearest rupee. */
export function presentValue(future: number, ratePercent: number, years: number): number {
  if (future <= 0) return 0;
  return divRound(big(future) * pow(HUNDRED, years), pow(HUNDRED + big(ratePercent), years));
}

/** The value at the end of each year, from year 0 (the starting amount) to `years`. */
export function growthSeries(principal: number, ratePercent: number, years: number): number[] {
  return Array.from({ length: years + 1 }, (_, year) => futureValue(principal, ratePercent, year));
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

/** Money received minus money paid. */
export function netCashFlow(received: readonly number[], paid: readonly number[]): number {
  const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
  return sum(received) - sum(paid);
}

/**
 * A cash balance after each signed movement, in order. `lowest` is the smallest balance reached:
 * a story must never show a player below zero, so its scenes are checked against it.
 */
export function cashAfter(start: number, movements: readonly number[]): { balances: number[]; end: number; lowest: number } {
  const balances: number[] = [];
  let balance = start;
  let lowest = start;
  for (const movement of movements) {
    balance += movement;
    lowest = Math.min(lowest, balance);
    balances.push(balance);
  }
  return { balances, end: balance, lowest };
}

// ---------------------------------------------------------------------------
// Business Banker rules the stories quote (read from the game's own rule set)
// ---------------------------------------------------------------------------

/** Income Tax: a fixed amount per property owned, up to the cap. */
export function incomeTaxFor(propertyCount: number): number {
  return Math.min(propertyCount * RULES.incomeTax.perProperty, RULES.incomeTax.max);
}

/** Mortgaging pays the printed mortgage value; unmortgaging costs that plus the game's interest. */
export function mortgageTerms(mortgageValue: number): { payout: number; unmortgageCost: number; interest: number } {
  const interest = Math.round(mortgageValue * RULES.mortgage.unmortgageInterestRate);
  return { payout: mortgageValue, unmortgageCost: mortgageValue + interest, interest };
}

/** What the bank pays for one house sold back. */
export function houseSellBack(houseCost: number): number {
  return Math.floor(houseCost * RULES.building.sellBackRate);
}

/** A Classic bank loan: interest on the principal, charged at the borrower's next Start. */
export function classicLoanInterest(principal: number): number {
  return Math.round((principal * RULES.loans.interestRatePercent) / 100);
}

/** A sample credit score after each event, using the game's configured score changes and limits. */
export function creditScoresAfter(start: number, events: readonly CreditEventType[]): number[] {
  const scores: number[] = [];
  let score = start;
  for (const event of events) {
    score = clampScore(score + IR.credit.events[event]);
    scores.push(score);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export interface RepaymentYear {
  year: number;
  ratePercent: number;
  payment: number;
  interest: number;
  balanceAfter: number;
}

/**
 * A yearly repayment schedule where each year may carry its own rate (one entry of `ratesByYear`
 * per year; a fixed-rate loan repeats the same rate). Each year the level payment is worked out
 * again for what is still owed, at that year's rate, over the years that remain — the same
 * amortizing maths the game's bank uses. The last payment clears the loan exactly.
 */
export function repaymentSchedule(principal: number, ratesByYear: readonly number[]): RepaymentYear[] {
  const lines: RepaymentYear[] = [];
  let balance = principal;
  ratesByYear.forEach((ratePercent, i) => {
    const remaining = ratesByYear.length - i;
    const interest = annualInterest(balance, ratePercent);
    const part = remaining === 1 ? balance : Math.min(balance, Math.max(0, annualInstallment(balance, ratePercent, remaining) - interest));
    balance -= part;
    lines.push({ year: i + 1, ratePercent, payment: part + interest, interest, balanceAfter: balance });
  });
  return lines;
}

export function totalRepaid(schedule: readonly RepaymentYear[]): number {
  return schedule.reduce((sum, line) => sum + line.payment, 0);
}
