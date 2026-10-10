import { getDeed, type PropertyKey } from './businessBoard.ts';
import { formatINR } from './format.ts';
import { INTERMEDIATE_RULES as IR, LOAN_PRODUCT_KEYS, type LoanProductKey } from './intermediateConfig.ts';
import {
  accruedInterest,
  buildSchedule,
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
  economyOf,
  gameClock,
  isPledged,
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
import { buildingCost, intermediateDebt, intermediateNetAssets, ownedBy, unmortgageCost } from './selectors.ts';
import type { GameState } from './types.ts';

/**
 * Read-only views of an Intermediate game: what the engine validates against and what the
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

/** Outstanding principal across a player's Intermediate loans (what the aggregate limit counts). */
export function intermediatePrincipalOwed(eco: IntermediateState, playerId: string): number {
  return loansOf(eco, playerId).reduce((sum, l) => sum + loanOutstandingPrincipal(l), 0);
}

export function borrowingCapacity(eco: IntermediateState, playerId: string): number {
  return Math.max(0, LOANS.maxOutstandingPrincipal - intermediatePrincipalOwed(eco, playerId));
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
  marketValue: number;
  /** The most this property can secure. */
  limit: number;
}

/** Properties this player could pledge: owned outright, undeveloped, not mortgaged, not already pledged. */
export function eligibleCollateral(state: Pick<GameState, 'properties' | 'mode' | 'intermediate'>, playerId: string): CollateralOption[] {
  const eco = economyOf(state);
  if (!eco) return [];
  return ownedBy(state, playerId)
    .filter((key) => {
      const p = state.properties[key];
      return !!p && !p.mortgaged && !p.hotel && p.houses === 0 && !isPledged(state, key);
    })
    .map((key) => {
      const marketValue = eco.market[key]?.value ?? getDeed(key).price;
      return { key, marketValue, limit: collateralLimit(marketValue) };
    })
    .filter((c) => c.limit >= LOANS.minAmount);
}

export interface LoanOffer {
  product: LoanProductKey;
  name: string;
  summary: string;
  rateType: 'FIXED' | 'VARIABLE';
  secured: boolean;
  tenureYears: number;
  productLimit: number;
  marketRatePercent: number;
  creditAdjustmentPercent: number;
  /** The personalised annual rate this player would sign at. */
  ratePercent: number;
  /** The most this player can borrow on this product right now (0 when blocked). */
  maxAmount: number;
  /** Why the offer can't be taken at all right now, or null. */
  blocked: string | null;
  collateral: CollateralOption[];
}

type OfferState = Pick<GameState, 'properties' | 'players' | 'status' | 'mode' | 'intermediate'>;

/** The five loan offers as they stand for one player: personalised rate, limits, and why any is unavailable. */
export function loanOffers(state: OfferState, playerId: string): LoanOffer[] {
  const eco = economyOf(state);
  if (!eco) return [];
  const player = state.players.find((p) => p.id === playerId);
  const score = creditScoreOf(eco, playerId);
  const capacity = borrowingCapacity(eco, playerId);
  const collateral = eligibleCollateral(state, playerId);
  const general =
    state.status !== 'ACTIVE'
      ? state.status === 'PAUSED'
        ? 'Game is paused.'
        : 'Game is not running.'
      : !player || player.status !== 'ACTIVE'
        ? 'You are out of the game.'
        : borrowingBlock(eco, playerId);
  return LOAN_PRODUCT_KEYS.map((product) => {
    const def = LOANS.products[product];
    const rate = offeredRate(product, score);
    const secured = def.secured ? collateral : [];
    const best = def.secured ? Math.max(0, ...secured.map((c) => c.limit)) : Number.POSITIVE_INFINITY;
    const maxAmount = floorTo(Math.min(def.maxPrincipal, capacity, best), LOANS.step);
    const blocked =
      general ??
      (capacity < LOANS.minAmount
        ? `You have reached the ${formatINR(LOANS.maxOutstandingPrincipal)} borrowing limit.`
        : def.secured && secured.length === 0
          ? 'Needs a property you own outright: not mortgaged, not already pledged, and with no buildings.'
          : null);
    return {
      product,
      name: def.name,
      summary: def.summary,
      rateType: def.rateType,
      secured: def.secured,
      tenureYears: def.tenureYears,
      productLimit: def.maxPrincipal,
      ...rate,
      maxAmount: blocked ? 0 : maxAmount,
      blocked,
      collateral: secured,
    };
  });
}

/** Why this exact request would be refused, or null. The engine runs it; the Borrow screen shows the same answer. */
export function loanRequestBlocker(state: OfferState, playerId: string, product: LoanProductKey, amount: number, collateralKey: PropertyKey | null): string | null {
  const offer = loanOffers(state, playerId).find((o) => o.product === product);
  if (!offer) return 'Loans like this are only offered in Intermediate Mode.';
  if (offer.blocked) return offer.blocked;
  if (!Number.isInteger(amount) || amount < LOANS.minAmount) return `Minimum loan is ${formatINR(LOANS.minAmount)}.`;
  if (amount % LOANS.step !== 0) return `Loans come in steps of ${formatINR(LOANS.step)}.`;
  if (amount > offer.productLimit) return `${offer.name}s go up to ${formatINR(offer.productLimit)}.`;
  const eco = economyOf(state)!;
  const capacity = borrowingCapacity(eco, playerId);
  if (amount > capacity) return `Your total borrowing limit is ${formatINR(LOANS.maxOutstandingPrincipal)}. You can borrow ${formatINR(capacity)} more.`;
  if (!offer.secured) return collateralKey ? 'This loan takes no collateral.' : null;
  if (!collateralKey) return 'Choose the property to pledge.';
  const pledge = offer.collateral.find((c) => c.key === collateralKey);
  if (!pledge) return `${getDeed(collateralKey).name} can't be pledged: it must be yours outright, unmortgaged, unpledged and without buildings.`;
  if (amount > pledge.limit) return `${getDeed(collateralKey).name} can secure up to ${formatINR(pledge.limit)} (${LOANS.collateralAdvancePercent}% of its market value).`;
  return null;
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
  const next = nextScheduledInstallment(loan);
  const length = yearLength(eco);
  const elapsed = next ? gameClock(eco) - (next.dueAt - length) : 0;
  const interest = accruedInterest(principal, loan.ratePercent, elapsed, length);
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
  /** Principal plus interest already due. */
  loanLiability: number;
  /** netAssets − loanLiability. */
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

export function financialOverview(state: Pick<GameState, 'properties' | 'players' | 'mode' | 'intermediate'>, playerId: string): FinancialOverview | null {
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
    netWorth: netAssets - liability,
    creditScore: score,
    creditBand: creditBand(score).label,
    debtRatio: debtRatio(loanPrincipal, netAssets),
    nextPayment,
    overdueAmount: owed.filter((o) => o.status === 'OVERDUE').reduce((s, o) => s + o.amount, 0),
    defaultedAmount: defaultedLoans(eco, playerId).reduce((s, l) => s + l.defaultBalance, 0),
    cashAfterNextPayment: player.balance - (nextPayment?.amount ?? 0),
    borrowingBlocked: borrowingBlock(eco, playerId),
    borrowingCapacity: borrowingCapacity(eco, playerId),
  };
}
