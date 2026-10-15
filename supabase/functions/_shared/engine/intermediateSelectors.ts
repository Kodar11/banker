import { BOARD_SIZE, getDeed, type PropertyKey } from './businessBoard.ts';
import { formatINR } from './format.ts';
import { configOf, type ConfigAware } from './gameConfig.ts';
import { INTERMEDIATE_RULES as IR, LOAN_PRODUCT_KEYS, type LoanProductKey } from './intermediateConfig.ts';
import {
  buildSchedule,
  collateralBuildingValue,
  collateralLimit,
  creditBand,
  debtRatio,
  floorTo,
  offeredRate,
  projectedValue,
  realValue,
  scheduleTotal,
  type ScheduleLine,
} from './intermediateFinance.ts';
import {
  accruedLoanInterest,
  crisisOwed,
  economyOf,
  gameClock,
  isPledged,
  loanCollateralKeys,
  loanOutstandingPrincipal,
  loansOf,
  scheduledPrincipal,
  unpaidInstallments,
  yearAt,
  yearLength,
  type Installment,
  type IntermediateLoan,
  type IntermediateState,
} from './intermediateState.ts';
import { balanceSheet, buildingCost, intermediateDebt, intermediateNetAssets, openResaleFor, ownedBy, unmortgageCost } from './selectors.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import type { GameState } from './types.ts';

/**
 * Read-only views of a Capital game: what the engine validates against and what the
 * screens display. Nothing here changes state, and every figure comes from the server's
 * persisted economy — a device never decides a rate, a due date or a value.
 */

const LOANS = IR.loans;

// ---------------------------------------------------------------------------
// Game calendar
// ---------------------------------------------------------------------------

/** A game-clock point as players read it: "Year 3" at a year boundary, otherwise "Year 3 · 40%" (how far into that year). */
export function clockLabel(eco: Pick<IntermediateState, 'playerCount'>, clock: number): string {
  const length = yearLength(eco);
  const year = yearAt(eco, clock);
  const through = Math.floor(((clock % length) * 100) / length);
  return through === 0 ? `start of Year ${year}` : `Year ${year} · ${through}% through`;
}

/** How far the current financial year has run, 0–99. */
export function yearProgressPercent(eco: IntermediateState): number {
  const length = yearLength(eco);
  return Math.floor(((gameClock(eco) % length) * 100) / length);
}

/** When an installment stops being on time, and when leaving it unpaid defaults the loan. */
export function installmentDeadlines(eco: Pick<IntermediateState, 'playerCount'>, installment: Pick<Installment, 'dueAt'>): { overdueAt: number; defaultAt: number } {
  const length = yearLength(eco);
  const overdueAt = installment.dueAt + Math.floor((length * LOANS.paymentWindowPercent) / 100);
  return { overdueAt, defaultAt: overdueAt + LOANS.graceYears * length };
}

// ---------------------------------------------------------------------------
// Property valuation
// ---------------------------------------------------------------------------

export interface PropertyValuation {
  originalPrice: number;
  marketValue: number;
  /** Change applied at the last year transition; null before the first one. */
  lastChangePercent: number | null;
  trendPercent: number;
  projectionYears: number;
  /** Estimate from the trend only — not a guaranteed price. */
  projectedValue: number;
  /** Today's market value in Year-1 money. */
  realValue: number;
  /** The original price carried forward at inflation: what it would need to be worth to have kept its purchasing power. */
  inflationYears: number;
}

export function propertyValuation(state: Pick<GameState, 'mode' | 'intermediate'>, key: PropertyKey): PropertyValuation | null {
  const eco = economyOf(state);
  const entry = eco?.market[key];
  if (!eco || !entry) return null;
  const years = eco.year - 1;
  return {
    originalPrice: getDeed(key).price,
    marketValue: entry.value,
    lastChangePercent: entry.lastChangePercent,
    trendPercent: entry.trendPercent,
    projectionYears: IR.market.projectionYears,
    projectedValue: projectedValue(entry.value, entry.trendPercent),
    realValue: realValue(entry.value, years),
    inflationYears: years,
  };
}

// ---------------------------------------------------------------------------
// Borrowing
// ---------------------------------------------------------------------------

export function creditScoreOf(eco: IntermediateState, playerId: string): number {
  return eco.credit[playerId] ?? IR.credit.start;
}

/** Outstanding principal across a player's Capital loans (what the aggregate limit counts). */
export function intermediatePrincipalOwed(eco: IntermediateState, playerId: string): number {
  return loansOf(eco, playerId).reduce((sum, l) => sum + loanOutstandingPrincipal(l), 0);
}

/**
 * How much more principal this player may borrow in total under the game's loan limit (`limit`:
 * configOf(state).loanLimit). Each product's own maximum and its collateral still apply on top.
 */
export function borrowingCapacity(eco: IntermediateState, playerId: string, limit: number): number {
  return Math.max(0, limit - intermediatePrincipalOwed(eco, playerId));
}

export function overdueInstallments(eco: IntermediateState, playerId: string): { loan: IntermediateLoan; installment: Installment }[] {
  return loansOf(eco, playerId)
    .filter((l) => l.status === 'ACTIVE')
    .flatMap((loan) => loan.installments.filter((i) => i.status === 'OVERDUE').map((installment) => ({ loan, installment })));
}

export function defaultedLoans(eco: IntermediateState, playerId: string): IntermediateLoan[] {
  return loansOf(eco, playerId).filter((l) => l.status === 'DEFAULTED');
}

/** Why this player may not take any new loan right now, or null. */
export function borrowingBlock(eco: IntermediateState, playerId: string): string | null {
  if (defaultedLoans(eco, playerId).length) return 'You have a loan in default. Clear its balance before borrowing again.';
  if (overdueInstallments(eco, playerId).length) return 'You have an overdue payment. Pay it before borrowing again.';
  return null;
}

export interface CollateralOption {
  key: PropertyKey;
  /** The property's market value today. */
  marketValue: number;
  /** Its buildings, at IR.loans.collateralBuildingPercent of what they cost to build. */
  buildingValue: number;
  houses: number;
  hotel: boolean;
  /** What it adds to a pledge: marketValue + buildingValue. */
  value: number;
}

/**
 * Properties this player could pledge, with their buildings: owned, not mortgaged (a property carries one
 * claim at a time — a mortgage or a pledge, never both), not pledged to another live loan, and not up for
 * auction. `releasing`: a loan being refinanced — what it holds is free for the loan that replaces it.
 */
export function eligibleCollateral(
  state: Pick<GameState, 'properties' | 'mode' | 'intermediate'> & { auction?: GameState['auction'] },
  playerId: string,
  releasing: IntermediateLoan | null = null,
): CollateralOption[] {
  const eco = economyOf(state);
  if (!eco) return [];
  const freed = new Set(releasing ? loanCollateralKeys(releasing) : []);
  return ownedBy(state, playerId)
    .filter((key) => {
      const p = state.properties[key];
      return !!p && !p.mortgaged && (freed.has(key) || !isPledged(state, key)) && !openResaleFor(state, key);
    })
    .map((key) => {
      const p = state.properties[key];
      const marketValue = eco.market[key]?.value ?? getDeed(key).price;
      const buildings = collateralBuildingValue(buildingCost(p));
      return { key, marketValue, buildingValue: buildings, houses: p.houses, hotel: p.hotel, value: marketValue + buildings };
    });
}

/** The pooled value of a set of collateral options. */
export function pooledCollateralValue(options: readonly Pick<CollateralOption, 'value'>[]): number {
  return options.reduce((sum, c) => sum + c.value, 0);
}

/**
 * The Start reward a player can count on in one financial year: a year is IR.year.spacesPerYear spaces of
 * movement each, so this many laps of the board. Rent, sales and cards are never assumed.
 */
export function annualStartIncome(): number {
  return Math.floor((RULES.start.passReward * IR.year.spacesPerYear) / BOARD_SIZE);
}

/**
 * What a player's loans ask of them over the coming year: every installment due now, plus each active
 * loan's next scheduled installment. `excludeLoanId`: a loan being refinanced, whose payments end.
 */
export function annualDebtService(eco: IntermediateState, playerId: string, excludeLoanId: string | null = null): number {
  let total = 0;
  for (const loan of loansOf(eco, playerId)) {
    if (loan.status !== 'ACTIVE' || loan.id === excludeLoanId) continue;
    total += unpaidInstallments(loan).reduce((s, i) => s + i.principal + i.interest, 0);
    const next = loan.installments.find((i) => i.status === 'SCHEDULED');
    if (next) total += next.principal + next.interest;
  }
  return total;
}

/**
 * Repayment capacity: the most a year of installments on all of a player's loans may come to — their net
 * worth (balanceSheet, so every liability already counted once) plus the Start income of
 * IR.loans.affordabilityIncomeYears years. Never below zero. Borrowing itself does not move it: the cash a
 * loan pays out is matched by what is owed on it.
 */
export function repaymentBudget(state: Pick<GameState, 'properties' | 'players' | 'mode' | 'intermediate'> & { loans?: GameState['loans'] }, playerId: string): number {
  return Math.max(0, balanceSheet(state, playerId).netWorth + annualStartIncome() * LOANS.affordabilityIncomeYears);
}

/** A new loan's first-year payment (for a one-year loan, the whole repayment). */
export function firstYearPayment(product: LoanProductKey, amount: number, ratePercent: number): number {
  const first = buildSchedule(amount, ratePercent, LOANS.products[product].tenureYears)[0];
  return first ? first.principal + first.interest : 0;
}

/** The largest amount, in loan steps between the minimum and `upper`, whose first-year payment fits `budget`; 0 if none does. */
function affordableAmount(product: LoanProductKey, ratePercent: number, budget: number, upper: number): number {
  let lo = Math.ceil(LOANS.minAmount / LOANS.step);
  let hi = Math.floor(upper / LOANS.step);
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (firstYearPayment(product, mid * LOANS.step, ratePercent) <= budget) {
      best = mid * LOANS.step;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export interface LoanOffer {
  product: LoanProductKey;
  name: string;
  summary: string;
  rateType: 'FIXED' | 'VARIABLE';
  secured: boolean;
  tenureYears: number;
  /** The smallest loan the bank makes. */
  minAmount: number;
  productLimit: number;
  marketRatePercent: number;
  creditAdjustmentPercent: number;
  /** The personalised annual rate this player would sign at. */
  ratePercent: number;
  /** The most this player can borrow on this product right now (0 when blocked). */
  maxAmount: number;
  /** Why the offer can't be taken at all right now, or null. */
  blocked: string | null;
  /** Secured only: what could be pledged, its pooled value, and the most all of it could secure. */
  collateral: CollateralOption[];
  collateralValue: number;
  collateralLimit: number;
  /** Repayment capacity (repaymentBudget) less what existing loans already ask of the coming year. */
  paymentBudget: number;
}

type OfferState = Pick<GameState, 'properties' | 'players' | 'status' | 'mode' | 'intermediate'> & ConfigAware & { loans?: GameState['loans']; auction?: GameState['auction'] };

/** A loan of this player's that may be refinanced (or null): active, theirs. */
function replacedLoan(eco: IntermediateState, playerId: string, loanId: string | null | undefined): IntermediateLoan | null {
  if (!loanId) return null;
  return loansOf(eco, playerId).find((l) => l.id === loanId && l.status === 'ACTIVE') ?? null;
}

export interface OfferOptions {
  /** Refinancing: the loan the new one replaces. Its principal, payments and collateral are freed for the offer. */
  replacingLoanId?: string | null;
}

const repaymentMessage = (budget: number) =>
  `Repayment limit: a year of payments on all your loans can’t exceed your net worth plus a year of Start rewards. You have room for ${formatINR(Math.max(0, budget))} a year more.`;

/** The five loan offers as they stand for one player: personalised rate, limits, and why any is unavailable. */
export function loanOffers(state: OfferState, playerId: string, options: OfferOptions = {}): LoanOffer[] {
  const eco = economyOf(state);
  if (!eco) return [];
  const player = state.players.find((p) => p.id === playerId);
  const score = creditScoreOf(eco, playerId);
  const limit = configOf(state).loanLimit;
  const replacing = replacedLoan(eco, playerId, options.replacingLoanId);
  const capacity = Math.min(limit, borrowingCapacity(eco, playerId, limit) + (replacing ? loanOutstandingPrincipal(replacing) : 0));
  const collateral = eligibleCollateral(state, playerId, replacing);
  const pool = pooledCollateralValue(collateral);
  const poolLimit = collateralLimit(pool);
  const budget = repaymentBudget(state, playerId) - annualDebtService(eco, playerId, replacing?.id ?? null);
  const general =
    state.status !== 'ACTIVE'
      ? state.status === 'PAUSED'
        ? 'Game is paused.'
        : 'Game is not running.'
      : !player || player.status !== 'ACTIVE'
        ? 'You are out of the game.'
        : options.replacingLoanId && !replacing
          ? 'That loan can no longer be refinanced.'
          : borrowingBlock(eco, playerId);
  return LOAN_PRODUCT_KEYS.map((product) => {
    const def = LOANS.products[product];
    const rate = offeredRate(product, score);
    const secured = def.secured ? collateral : [];
    const upper = floorTo(Math.min(def.maxPrincipal, LOANS.maxSingleLoan, capacity, def.secured ? poolLimit : Number.POSITIVE_INFINITY), LOANS.step);
    const affordable = upper >= LOANS.minAmount ? affordableAmount(product, rate.ratePercent, budget, upper) : 0;
    const blocked =
      general ??
      (capacity < LOANS.minAmount
        ? `You have reached the ${formatINR(limit)} borrowing limit.`
        : def.secured && secured.length === 0
          ? 'Needs property you own that is not mortgaged, not already pledged and not up for auction.'
          : def.secured && poolLimit < LOANS.minAmount
            ? `Everything you could pledge is worth ${formatINR(pool)}: ${LOANS.collateralAdvancePercent}% of it is ${formatINR(poolLimit)}, below the ${formatINR(LOANS.minAmount)} minimum.`
            : affordable === 0
              ? repaymentMessage(budget)
              : null);
    return {
      product,
      name: def.name,
      summary: def.summary,
      rateType: def.rateType,
      secured: def.secured,
      tenureYears: def.tenureYears,
      minAmount: LOANS.minAmount,
      productLimit: def.maxPrincipal,
      ...rate,
      maxAmount: blocked ? 0 : affordable,
      blocked,
      collateral: secured,
      collateralValue: def.secured ? pool : 0,
      collateralLimit: def.secured ? poolLimit : 0,
      paymentBudget: Math.max(0, budget),
    };
  });
}

/** Why this exact request would be refused, or null. The engine runs it; the Borrow screen shows the same answer. */
export function loanRequestBlocker(
  state: OfferState,
  playerId: string,
  product: LoanProductKey,
  amount: number,
  collateralKeys: readonly PropertyKey[],
  options: OfferOptions = {},
): string | null {
  const offer = loanOffers(state, playerId, options).find((o) => o.product === product);
  if (!offer) return 'Loans like this are only offered in Capital Mode.';
  if (offer.blocked) return offer.blocked;
  if (!Number.isInteger(amount) || amount < LOANS.minAmount) return `Minimum loan is ${formatINR(LOANS.minAmount)}.`;
  if (amount % LOANS.step !== 0) return `Loans come in steps of ${formatINR(LOANS.step)}.`;
  if (amount > offer.productLimit) return `${offer.name}s go up to ${formatINR(offer.productLimit)}.`;
  if (amount > LOANS.maxSingleLoan) return `No single loan can be more than ${formatINR(LOANS.maxSingleLoan)}.`;
  const eco = economyOf(state)!;
  const limit = configOf(state).loanLimit;
  const replacing = replacedLoan(eco, playerId, options.replacingLoanId);
  const capacity = Math.min(limit, borrowingCapacity(eco, playerId, limit) + (replacing ? loanOutstandingPrincipal(replacing) : 0));
  if (amount > capacity) return `Your total borrowing limit is ${formatINR(limit)}. You can borrow ${formatINR(capacity)} more.`;
  if (!offer.secured) {
    if (collateralKeys.length) return 'This loan takes no collateral.';
  } else {
    if (collateralKeys.length === 0) return 'Choose at least one property to pledge.';
    if (new Set(collateralKeys).size !== collateralKeys.length) return 'A property can only be pledged once.';
    const pledged: CollateralOption[] = [];
    for (const key of collateralKeys) {
      const option = offer.collateral.find((c) => c.key === key);
      if (!option) return `${getDeed(key).name} can't be pledged: it must be yours, not mortgaged, not already pledged and not up for auction.`;
      pledged.push(option);
    }
    const value = pooledCollateralValue(pledged);
    const secures = collateralLimit(value);
    if (amount > secures) return `What you pledged is worth ${formatINR(value)} and can secure up to ${formatINR(secures)} (${LOANS.collateralAdvancePercent}%).`;
  }
  if (firstYearPayment(product, amount, offer.ratePercent) > offer.paymentBudget) return repaymentMessage(offer.paymentBudget);
  return null;
}

/** Why this loan can't be refinanced right now (before choosing new terms), or null. */
export function refinanceBlocker(eco: IntermediateState, playerId: string, loanId: string): string | null {
  const loan = loansOf(eco, playerId).find((l) => l.id === loanId);
  if (!loan) return 'Loan not found.';
  if (loan.status !== 'ACTIVE') return 'Only a loan being repaid on its schedule can be refinanced.';
  if (unpaidInstallments(loan).length) return 'Pay the installment that is due first.';
  if (scheduledPrincipal(loan) <= 0) return 'Nothing left to refinance.';
  return borrowingBlock(eco, playerId);
}

export interface LoanPreview {
  lines: ScheduleLine[];
  principal: number;
  interest: number;
  total: number;
}

/** The schedule a loan of `amount` at `ratePercent` would be signed with. */
export function previewLoan(product: LoanProductKey, amount: number, ratePercent: number): LoanPreview {
  const lines = buildSchedule(amount, ratePercent, LOANS.products[product].tenureYears);
  return { lines, ...scheduleTotal(lines) };
}

// ---------------------------------------------------------------------------
// Repaying
// ---------------------------------------------------------------------------

/** The installment "Pay now" settles: the oldest one that has fallen due and is unpaid. */
export function payableInstallment(loan: IntermediateLoan): Installment | null {
  return loan.status === 'ACTIVE' ? (unpaidInstallments(loan)[0] ?? null) : null;
}

/** The next installment that has not fallen due yet. */
export function nextScheduledInstallment(loan: IntermediateLoan): Installment | null {
  return loan.status === 'ACTIVE' ? (loan.installments.find((i) => i.status === 'SCHEDULED') ?? null) : null;
}

export interface PrepaymentQuote {
  principal: number;
  /** Interest that has built up on that principal since the loan year began. */
  accruedInterest: number;
  total: number;
  /** Principal still on the schedule afterwards. */
  remainingPrincipal: number;
}

/** Why principal can't be prepaid on this loan right now, or null. */
export function prepaymentBlocker(loan: IntermediateLoan, principal: number): string | null {
  if (loan.status !== 'ACTIVE') return 'This loan is not being repaid on a schedule.';
  if (unpaidInstallments(loan).length) return 'Pay the installment that is due first.';
  const scheduled = scheduledPrincipal(loan);
  if (scheduled <= 0) return 'Nothing left to prepay.';
  if (!Number.isInteger(principal) || principal <= 0) return 'Enter an amount.';
  if (principal > scheduled) return `Only ${formatINR(scheduled)} of principal is left.`;
  return null;
}

/** What repaying `principal` early costs right now: that principal plus the interest accrued on it. No penalty. */
export function prepaymentQuote(eco: IntermediateState, loan: IntermediateLoan, principal: number): PrepaymentQuote {
  const interest = accruedLoanInterest(eco, loan, principal);
  return { principal, accruedInterest: interest, total: principal + interest + LOANS.prepaymentPenalty, remainingPrincipal: scheduledPrincipal(loan) - principal };
}

// ---------------------------------------------------------------------------
// Financial position
// ---------------------------------------------------------------------------

export interface Obligation {
  loan: IntermediateLoan;
  installment: Installment;
  amount: number;
  /** DUE / OVERDUE are owed now; SCHEDULED is upcoming. */
  status: 'DUE' | 'OVERDUE' | 'SCHEDULED';
  /** For DUE: when it turns overdue. For OVERDUE: when the loan defaults. For SCHEDULED: when it falls due. */
  deadline: number;
}

/** A player's installments that are owed now, oldest first, then the next upcoming one of each loan. */
export function obligations(eco: IntermediateState, playerId: string): Obligation[] {
  const out: Obligation[] = [];
  for (const loan of loansOf(eco, playerId)) {
    if (loan.status !== 'ACTIVE') continue;
    for (const installment of unpaidInstallments(loan)) {
      const { overdueAt, defaultAt } = installmentDeadlines(eco, installment);
      const status = installment.status === 'OVERDUE' ? 'OVERDUE' : 'DUE';
      out.push({ loan, installment, amount: installment.principal + installment.interest, status, deadline: status === 'OVERDUE' ? defaultAt : overdueAt });
    }
    const next = nextScheduledInstallment(loan);
    if (next) out.push({ loan, installment: next, amount: next.principal + next.interest, status: 'SCHEDULED', deadline: next.dueAt });
  }
  const rank = { OVERDUE: 0, DUE: 1, SCHEDULED: 2 } as const;
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.installment.dueAt - b.installment.dueAt);
}

/** Installments this player must pay now (due or overdue). Drives the private reminder. */
export function paymentsOwedNow(eco: IntermediateState, playerId: string): Obligation[] {
  return obligations(eco, playerId).filter((o) => o.status !== 'SCHEDULED');
}

export interface FinancialOverview {
  cash: number;
  /** Owned properties at current market value. */
  propertyValue: number;
  /** Houses and hotels at what they cost to build. */
  buildingValue: number;
  propertyCount: number;
  mortgagedCount: number;
  /** What redeeming every mortgage would cost (mortgage value + redemption charge). */
  mortgageRedemption: number;
  /** cash + property + buildings − mortgage redemption. */
  netAssets: number;
  loanPrincipal: number;
  /** What would close every loan today: principal, interest due, interest accrued this loan year, defaulted balances. */
  loanLiability: number;
  /** The part of loanLiability that is interest accrued but not yet due. */
  accruedInterest: number;
  /** A crisis bill this player still owes (0 when none). */
  crisisOwed: number;
  /** netAssets − loanLiability − crisisOwed. */
  netWorth: number;
  creditScore: number;
  creditBand: string;
  debtRatio: number;
  nextPayment: Obligation | null;
  overdueAmount: number;
  defaultedAmount: number;
  /** Cash left if the next payment were made today. */
  cashAfterNextPayment: number;
  borrowingBlocked: string | null;
  borrowingCapacity: number;
}

export function financialOverview(state: Pick<GameState, 'properties' | 'players' | 'mode' | 'intermediate'> & ConfigAware, playerId: string): FinancialOverview | null {
  const eco = economyOf(state);
  const player = state.players.find((p) => p.id === playerId);
  if (!eco || !player) return null;
  const keys = ownedBy(state, playerId);
  let propertyValue = 0;
  let buildingValue = 0;
  let mortgageRedemption = 0;
  let mortgagedCount = 0;
  for (const key of keys) {
    const p = state.properties[key];
    propertyValue += eco.market[key]?.value ?? getDeed(key).price;
    buildingValue += buildingCost(p);
    if (p.mortgaged) {
      mortgagedCount += 1;
      mortgageRedemption += unmortgageCost(key);
    }
  }
  const netAssets = intermediateNetAssets(state, eco, playerId);
  const loanPrincipal = intermediatePrincipalOwed(eco, playerId);
  const liability = intermediateDebt(eco, playerId);
  const owed = obligations(eco, playerId);
  const nextPayment = owed[0] ?? null;
  const score = creditScoreOf(eco, playerId);
  return {
    cash: player.balance,
    propertyValue,
    buildingValue,
    propertyCount: keys.length,
    mortgagedCount,
    mortgageRedemption,
    netAssets,
    loanPrincipal,
    loanLiability: liability,
    accruedInterest: loansOf(eco, playerId).reduce((sum, l) => sum + accruedLoanInterest(eco, l), 0),
    crisisOwed: crisisOwed(eco, playerId),
    // The one net worth: the dashboard, the player sheets and the final standings all read balanceSheet.
    netWorth: balanceSheet(state, playerId).netWorth,
    creditScore: score,
    creditBand: creditBand(score).label,
    debtRatio: debtRatio(loanPrincipal, netAssets),
    nextPayment,
    overdueAmount: owed.filter((o) => o.status === 'OVERDUE').reduce((s, o) => s + o.amount, 0),
    defaultedAmount: defaultedLoans(eco, playerId).reduce((s, l) => s + l.defaultBalance, 0),
    cashAfterNextPayment: player.balance - (nextPayment?.amount ?? 0),
    borrowingBlocked: borrowingBlock(eco, playerId),
    borrowingCapacity: borrowingCapacity(eco, playerId, configOf(state).loanLimit),
  };
}
