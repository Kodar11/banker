import { getDeed, PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';
import type { Draft } from './draft.ts';
import { fail } from './errors.ts';
import { formatINR } from './format.ts';
import { configOf } from './gameConfig.ts';
import { financialYearCap } from './gameEnd.ts';
import { processCrisisCheckpoints } from './insurance.ts';
import { freshInsurance } from './insuranceState.ts';
import { INTERMEDIATE_RULES as IR, type CreditEventType, type LoanProductKey } from './intermediateConfig.ts';
import {
  applyMarketChange,
  buildSchedule,
  clampScore,
  collateralBuildingValue,
  offeredRate,
  pickFrom,
  pickMarketChange,
  reviewedRate,
  settleCollateral,
} from './intermediateFinance.ts';
import {
  clockLabel,
  creditScoreOf,
  defaultedLoans,
  installmentDeadlines,
  loanRequestBlocker,
  overdueInstallments,
  payableInstallment,
  prepaymentBlocker,
  prepaymentQuote,
  refinanceBlocker,
} from './intermediateSelectors.ts';
import {
  accruedLoanInterest,
  economyOf,
  gameClock,
  isOpenLoan,
  loanCollateralKeys,
  loansOf,
  releaseCollateral,
  scheduledPrincipal,
  unpaidInstallments,
  yearAt,
  yearLength,
  type CollateralPledge,
  type IntermediateLoan,
  type IntermediateState,
  type MarketEntry,
  type YearReport,
} from './intermediateState.ts';
import { buildingCost } from './selectors.ts';
import type { PlayerState, PropertyState } from './types.ts';

/**
 * Capital Mode's state transitions. Every function works on the action's Draft, so
 * whatever it changes — economy, balances, ledger, events — commits with that action or
 * not at all, under the same game lock and the same exactly-once action id as any other move.
 *
 * The reducer calls in here only for Capital games; a Classic game never reaches this file.
 */

const LOANS = IR.loans;

function economy(d: Draft): IntermediateState {
  const eco = economyOf(d.state);
  if (!eco) fail('LOAN_NOT_ALLOWED', 'This is only available in Capital Mode.');
  return eco;
}

// ---------------------------------------------------------------------------
// Credit score — the one place a score changes
// ---------------------------------------------------------------------------

const CREDIT_REASONS: Record<CreditEventType, string> = {
  ON_TIME_PAYMENT: 'Paid an installment on time',
  INSTALLMENT_OVERDUE: 'An installment became overdue',
  CAUGHT_UP: 'Caught up on an overdue installment',
  LOAN_DEFAULT: 'A loan went into default',
  LOAN_REPAID: 'Repaid a loan in full, as agreed',
  CLEAN_YEAR: 'Finished a financial year with nothing overdue',
};

/**
 * Applies one credit event. `id` names the thing that happened; an id already in the history
 * is ignored, so no event can ever move a score twice — retries, repeated checkpoints and several
 * loans each count once per thing that happened.
 *
 * Gains are capped: in one financial year (`year`, the year the event belongs to) a player's score
 * rises by at most IR.credit.maxGainPerYear, whatever earned it. Penalties are never capped. A capped
 * event is still recorded — its id is used up — with the change it actually made (`delta`).
 */
function applyCreditEvent(d: Draft, eco: IntermediateState, input: { id: string; playerId: string; type: CreditEventType; loanId: string | null; year?: number }): void {
  if (eco.creditEvents.some((e) => e.id === input.id)) return;
  const year = input.year ?? eco.year;
  const before = creditScoreOf(eco, input.playerId);
  const earned = IR.credit.events[input.type];
  const gained = eco.creditEvents.filter((e) => e.playerId === input.playerId && e.year === year && e.delta > 0).reduce((sum, e) => sum + e.delta, 0);
  const allowed = earned > 0 ? Math.min(earned, Math.max(0, IR.credit.maxGainPerYear - gained)) : earned;
  const after = clampScore(before + allowed);
  const delta = after - before;
  eco.credit[input.playerId] = after;
  const capped = earned > 0 && allowed < earned;
  const reason = `${CREDIT_REASONS[input.type]}${capped ? ` (yearly limit of +${IR.credit.maxGainPerYear} reached)` : ''}`;
  eco.creditEvents.push({ id: input.id, playerId: input.playerId, type: input.type, loanId: input.loanId, delta, before, after, year, reason, createdAt: d.ctx.now });
  if (delta === 0) return;
  d.event('CREDIT_SCORE_CHANGED', input.playerId, `${d.name(input.playerId)}'s credit score ${before} → ${after} (${reason.toLowerCase()})`, {
    creditEventId: input.id,
    kind: input.type,
    loanId: input.loanId,
    before,
    after,
    delta,
  });
}

// ---------------------------------------------------------------------------
// Start of the game
// ---------------------------------------------------------------------------

/**
 * Creates the game's economy when a Capital game starts: Year 1, every property at its
 * original price with a trend drawn once from the server's RNG, every starting player at the
 * starting credit score with no movement.
 */
export function initEconomy(d: Draft, starters: readonly PlayerState[]): void {
  const market = Object.fromEntries(
    PROPERTY_KEYS.map((key): [PropertyKey, MarketEntry] => [
      key,
      { value: getDeed(key).price, trendPercent: pickFrom(IR.market.trendOptions, d.ctx.random), lastChangePercent: null },
    ]),
  ) as Record<PropertyKey, MarketEntry>;
  d.state.intermediate = {
    configVersion: IR.version,
    year: 1,
    playerCount: starters.length,
    movement: Object.fromEntries(starters.map((p) => [p.id, 0])),
    market,
    credit: Object.fromEntries(starters.map((p) => [p.id, IR.credit.start])),
    creditEvents: [],
    loans: [],
    yearFlags: Object.fromEntries(starters.map((p) => [p.id, { borrowed: false, late: false }])),
    lastReport: null,
    insurance: freshInsurance(),
  };
}

// ---------------------------------------------------------------------------
// The game clock: dice movement → financial years and loan checkpoints
// ---------------------------------------------------------------------------

/**
 * Records a dice move and brings the economy up to date with it, all inside the roll's own action:
 *   1. the mover's cumulative movement grows by the spaces the dice moved them;
 *   2. every financial year the shared average has now completed is started, one at a time;
 *   3. loan checkpoints the clock has passed are processed (rate reviews, due, overdue, default);
 *   4. each year that ended pays its clean-year credit reward and is announced;
 *   5. crisis checkpoints the clock has reached are resolved, and insurance cover that has run out ends.
 *
 * Only dice movement counts. Card moves, Jail and Rest House placements, reconnects and retried
 * requests never reach this function, so they can never advance the calendar.
 */
export function recordDiceMovement(d: Draft, player: PlayerState, spaces: number): void {
  const eco = economyOf(d.state);
  if (!eco || spaces <= 0 || !(player.id in eco.movement)) return;
  eco.movement[player.id] = (eco.movement[player.id] ?? 0) + spaces;
  advanceCalendar(d, eco);
}

/**
 * Brings the economy up to date with the game clock (steps 2–5 above). Every step is a one-way move
 * of stored state, so running it again at the same clock changes nothing.
 *
 * In a game with a duration the calendar stops at the game's last financial year: the year after it
 * does not begin — no market change, no new premiums — until the players have voted to play it
 * (financialYearCap). The reducer calls this again when they do. Loan and crisis checkpoints run on
 * the clock itself and are not held back.
 */
export function advanceCalendar(d: Draft, eco: IntermediateState): void {
  const target = Math.min(yearAt(eco, gameClock(eco)), financialYearCap(d.state));
  const reports: YearReport[] = [];
  while (eco.year < target) reports.push(startNextYear(d, eco));
  processLoanCheckpoints(d, eco);
  for (const report of reports) closeYear(d, eco, report);
  processCrisisCheckpoints(d, eco);
}

/** Starts the next financial year: one market change per property, drawn once and stored. */
function startNextYear(d: Draft, eco: IntermediateState): YearReport {
  eco.year += 1;
  const report: YearReport = { year: eco.year, changes: {} };
  // The host's volatility setting picks the distribution; everything else about a market year is unchanged.
  const profile = configOf(d.state).marketVolatility;
  for (const key of PROPERTY_KEYS) {
    const entry = eco.market[key];
    const percent = pickMarketChange(d.ctx.random, profile);
    const from = entry.value;
    entry.value = applyMarketChange(from, percent);
    entry.lastChangePercent = percent;
    report.changes[key] = { percent, from, to: entry.value };
  }
  eco.lastReport = report;
  return report;
}

function hasCreditProblem(eco: IntermediateState, playerId: string): boolean {
  return overdueInstallments(eco, playerId).length > 0 || defaultedLoans(eco, playerId).length > 0;
}

/** An installment has fallen due and is still unpaid (on time or not). */
function hasUnpaidInstallment(eco: IntermediateState, playerId: string): boolean {
  return loansOf(eco, playerId).some((l) => l.status === 'ACTIVE' && unpaidInstallments(l).length > 0);
}

/**
 * After the year's loan checkpoints: clean-year rewards, fresh flags for the new year, and the announcement.
 * A clean year is one with a real obligation met: an installment paid on time during it, and at its end
 * nothing due, overdue or in default — and nothing went late during it. Merely having a loan open is not enough.
 */
function closeYear(d: Draft, eco: IntermediateState, report: YearReport): void {
  const ended = report.year - 1;
  for (const player of d.activePlayers()) {
    const flags = eco.yearFlags[player.id];
    if (!flags) continue;
    const clean = flags.paidOnTime === true && !flags.late && !hasCreditProblem(eco, player.id) && !hasUnpaidInstallment(eco, player.id);
    if (clean) applyCreditEvent(d, eco, { id: `CLEAN_YEAR:${player.id}:${ended}`, playerId: player.id, type: 'CLEAN_YEAR', loanId: null, year: ended });
    eco.yearFlags[player.id] = { borrowed: loansOf(eco, player.id).some(isOpenLoan), late: hasCreditProblem(eco, player.id), paidOnTime: false };
  }
  const moves = PROPERTY_KEYS.map((key) => ({ key, ...report.changes[key]! }));
  const up = moves.filter((m) => m.to > m.from).length;
  const down = moves.filter((m) => m.to < m.from).length;
  d.event('FINANCIAL_YEAR_STARTED', null, `Year ${report.year} begins — ${up} properties rose, ${down} fell. Inflation ${IR.inflation.ratePercent}%`, {
    year: report.year,
    inflationPercent: IR.inflation.ratePercent,
    changes: report.changes,
  });
}

/**
 * Moves every installment the clock has passed to its next state, oldest step first:
 * everything that has fallen due, then everything whose payment window has closed, then a
 * default if an overdue installment has outlasted its grace period. Each transition is a
 * one-way step of a stored status, so running this again at the same clock changes nothing.
 * Loans of players who are no longer playing are frozen and skipped.
 */
function processLoanCheckpoints(d: Draft, eco: IntermediateState): void {
  const clock = gameClock(eco);
  const playing = new Set(d.activePlayers().map((p) => p.id));
  for (const loan of eco.loans) {
    if (loan.status !== 'ACTIVE' || !playing.has(loan.playerId)) continue;
    const label = (index: number) => `${LOANS.products[loan.product].name} installment ${index}`;
    for (const installment of loan.installments) {
      if (installment.status !== 'SCHEDULED' || clock < installment.dueAt) continue;
      installment.status = 'DUE';
      d.event('LOAN_INSTALLMENT_DUE', loan.playerId, `${d.name(loan.playerId)}'s ${label(installment.index)} of ${formatINR(installment.principal + installment.interest)} is due`, {
        loanId: loan.id,
        installment: installment.index,
        amount: installment.principal + installment.interest,
        payBy: installmentDeadlines(eco, installment).overdueAt,
      });
      reviewVariableRate(d, eco, loan, installment.dueAt);
    }
    for (const installment of loan.installments) {
      const { overdueAt, defaultAt } = installmentDeadlines(eco, installment);
      if (installment.status !== 'DUE' || clock < overdueAt) continue;
      installment.status = 'OVERDUE';
      const flags = eco.yearFlags[loan.playerId];
      if (flags) flags.late = true;
      d.event('LOAN_INSTALLMENT_OVERDUE', loan.playerId, `${d.name(loan.playerId)} missed ${label(installment.index)} — overdue`, {
        loanId: loan.id,
        installment: installment.index,
        amount: installment.principal + installment.interest,
        defaultAt,
      });
      applyCreditEvent(d, eco, { id: `INSTALLMENT_OVERDUE:${loan.id}:${installment.index}`, playerId: loan.playerId, type: 'INSTALLMENT_OVERDUE', loanId: loan.id });
    }
    // The oldest unresolved overdue installment sets the default deadline for the whole loan.
    const oldest = loan.installments.find((i) => i.status === 'OVERDUE');
    if (oldest && clock >= installmentDeadlines(eco, oldest).defaultAt) defaultLoan(d, eco, loan);
  }
}

/**
 * Annual review of a Flexible-rate loan, on the loan's own anniversary: the market component
 * moves by one drawn step, and the installments that have not fallen due yet are re-amortized
 * at the new rate. The installment that just fell due, and everything before it, is untouched.
 */
function reviewVariableRate(d: Draft, eco: IntermediateState, loan: IntermediateLoan, at: number): void {
  if (loan.rateType !== 'VARIABLE') return;
  const remaining = loan.installments.filter((i) => i.status === 'SCHEDULED');
  if (remaining.length === 0) return;
  const movePercent = pickFrom(LOANS.flexibleMoves, d.ctx.random);
  const before = loan.ratePercent;
  const next = reviewedRate(loan.marketRatePercent, movePercent, loan.creditAdjustmentPercent);
  loan.marketRatePercent = next.marketRatePercent;
  loan.ratePercent = next.ratePercent;
  loan.rateHistory.push({ clock: at, year: yearAt(eco, at), movePercent, ratePercent: loan.ratePercent });
  reschedule(loan, scheduledPrincipal(loan));
  d.event(
    'LOAN_RATE_CHANGED',
    loan.playerId,
    before === loan.ratePercent
      ? `${d.name(loan.playerId)}'s Flexible-rate Loan was reviewed: the rate stays at ${before}%`
      : `${d.name(loan.playerId)}'s Flexible-rate Loan was reviewed: ${before}% → ${loan.ratePercent}%`,
    { loanId: loan.id, before, after: loan.ratePercent, movePercent, effectiveAt: at },
  );
}

/** Spreads `principal` over the installments that have not fallen due yet, at the loan's current rate. */
function reschedule(loan: IntermediateLoan, principal: number): void {
  const remaining = loan.installments.filter((i) => i.status === 'SCHEDULED');
  const lines = buildSchedule(principal, loan.ratePercent, remaining.length);
  remaining.forEach((installment, i) => {
    installment.principal = lines[i]!.principal;
    installment.interest = lines[i]!.interest;
  });
}

/**
 * Default: an installment stayed unpaid through the whole grace period.
 *
 * The whole loan becomes payable at once. What is owed is fixed here and never grows again:
 *   installments already due (principal + interest)
 *   + the principal not yet due
 *   + the interest accrued on that principal since the current loan year began.
 * A secured loan's pledged property goes to the bank (seizeLoanCollateral); its value is set
 * against the debt, any surplus is paid to the borrower, any shortfall stays owed.
 * An unsecured loan seizes nothing. Either way the borrower is not bankrupt.
 */
function defaultLoan(d: Draft, eco: IntermediateState, loan: IntermediateLoan): void {
  const due = unpaidInstallments(loan).reduce((sum, i) => sum + i.principal + i.interest, 0);
  const notYetDue = scheduledPrincipal(loan);
  // The same accrual an early repayment would charge today (accruedLoanInterest): the balance is loanPayoff at this instant.
  const accrued = accruedLoanInterest(eco, loan);
  for (const installment of loan.installments) {
    if (installment.status === 'SCHEDULED' || installment.status === 'DUE' || installment.status === 'OVERDUE') installment.status = 'DEFAULTED';
  }
  loan.status = 'DEFAULTED';
  loan.defaultBalance = due + notYetDue + accrued;
  const flags = eco.yearFlags[loan.playerId];
  if (flags) flags.late = true;
  const name = LOANS.products[loan.product].name;
  d.event('LOAN_DEFAULTED', loan.playerId, `${d.name(loan.playerId)} defaulted on a ${name} — ${formatINR(loan.defaultBalance)} owed`, {
    loanId: loan.id,
    owed: loan.defaultBalance,
    installmentsDue: due,
    principalNotYetDue: notYetDue,
    accruedInterest: accrued,
  });
  applyCreditEvent(d, eco, { id: `LOAN_DEFAULT:${loan.id}`, playerId: loan.playerId, type: 'LOAN_DEFAULT', loanId: loan.id });

  const seized = seizeLoanCollateral(d, eco, loan, loan.defaultBalance);
  if (seized) {
    loan.defaultBalance = seized.remaining;
    // Ownership changed under any earlier action: none of them can be compensated safely any more.
    d.state.undoStack = [];
    d.state.undoRequest = null;
  }
  if (loan.defaultBalance === 0) closeLoan(d, loan, 'SETTLED');
}

/** What one pledged property would fetch today: its market value plus its buildings at their sell-back value. */
function recoveryValue(eco: IntermediateState, prop: PropertyState): number {
  return eco.market[prop.key].value + collateralBuildingValue(buildingCost(prop));
}

/**
 * Enforces a secured loan's collateral claim against `owed` (a default, or the borrower's estate being settled).
 * Only the properties pledged to THIS loan are taken — never any other asset of the borrower — each with its
 * buildings, valued today: market value + buildings at what selling them back to the bank pays. The pooled value
 * goes against `owed`; any surplus is paid to the borrower, any shortfall (`remaining`) stays owed on the loan.
 *
 * Once per loan: the claim ends here (releaseCollateral) and the properties go to the bank in the same step,
 * so running it again finds nothing pledged and returns null. Returns null for a loan with nothing pledged.
 */
export function seizeLoanCollateral(d: Draft, eco: IntermediateState, loan: IntermediateLoan, owed: number): { applied: number; surplus: number; remaining: number } | null {
  const keys = loanCollateralKeys(loan).filter((key) => d.state.properties[key]?.ownerId === loan.playerId);
  releaseCollateral(loan);
  if (keys.length === 0) return null;
  const value = keys.reduce((sum, key) => sum + recoveryValue(eco, d.state.properties[key]), 0);
  const { applied, surplus, remaining } = settleCollateral(value, owed);
  loan.settlement = { propertyKeys: keys, value, applied, surplus };
  for (const key of keys) {
    const prop = d.state.properties[key];
    prop.ownerId = null;
    prop.houses = 0;
    prop.hotel = false;
    prop.mortgaged = false;
  }
  const names = keys.map((key) => getDeed(key).name).join(', ');
  if (surplus > 0) {
    d.transfer({ type: 'COLLATERAL_SURPLUS', from: null, to: loan.playerId, amount: surplus, propertyKey: keys[0]!, memo: `Collateral surplus (${names})` });
  }
  d.event(
    'COLLATERAL_SEIZED',
    loan.playerId,
    `The bank took ${names} (worth ${formatINR(value)}) for ${d.name(loan.playerId)}'s ${LOANS.products[loan.product].name}` +
      (surplus > 0 ? ` and returned ${formatINR(surplus)}` : remaining > 0 ? ` — ${formatINR(remaining)} still owed` : ''),
    { loanId: loan.id, propertyKey: keys[0]!, propertyKeys: keys, value, applied, surplus, remaining },
  );
  return { applied, surplus, remaining };
}

function closeLoan(d: Draft, loan: IntermediateLoan, status: 'REPAID' | 'SETTLED' | 'WRITTEN_OFF'): void {
  loan.status = status;
  releaseCollateral(loan);
  loan.closedAt = d.ctx.now;
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

interface LoanRequest {
  product: LoanProductKey;
  amount: number;
  collateralKeys: readonly PropertyKey[];
  expectedRatePercent: number;
}

/** The contract the player confirmed must be the contract they get. */
function confirmedRate(eco: IntermediateState, actor: PlayerState, input: LoanRequest) {
  const rate = offeredRate(input.product, creditScoreOf(eco, actor.id));
  if (rate.ratePercent !== input.expectedRatePercent) {
    fail('STALE_STATE', `Your offer changed: the rate is now ${rate.ratePercent}%. Review the terms and confirm again.`);
  }
  return rate;
}

/**
 * Signs a loan whose request has already been validated (loanRequestBlocker): its schedule, its pledge (valued
 * as it stands now, for the record), the disbursement and the event. Shared by a new loan and a refinance.
 */
function originateLoan(d: Draft, eco: IntermediateState, actor: PlayerState, input: LoanRequest, rate: ReturnType<typeof offeredRate>, refinancedFrom: string | null): IntermediateLoan {
  const def = LOANS.products[input.product];
  const clock = gameClock(eco);
  const length = yearLength(eco);
  const keys = def.secured ? [...input.collateralKeys] : [];
  const pledges: CollateralPledge[] = keys.map((key) => {
    const prop = d.state.properties[key];
    return { key, propertyValue: eco.market[key].value, buildingValue: collateralBuildingValue(buildingCost(prop)), houses: prop.houses, hotel: prop.hotel };
  });
  const loan: IntermediateLoan = {
    id: d.ctx.newId(),
    playerId: actor.id,
    product: input.product,
    principal: input.amount,
    ...rate,
    rateType: def.rateType,
    tenureYears: def.tenureYears,
    collateralKey: null,
    collateralKeys: keys,
    pledges,
    ...(refinancedFrom ? { refinancedFrom } : {}),
    originClock: clock,
    originYear: eco.year,
    // Installment k falls due k full financial years after signing — never sooner.
    installments: buildSchedule(input.amount, rate.ratePercent, def.tenureYears).map((line, i) => ({
      index: i + 1,
      dueAt: clock + (i + 1) * length,
      principal: line.principal,
      interest: line.interest,
      status: 'SCHEDULED' as const,
      paidAt: null,
    })),
    status: 'ACTIVE',
    defaultBalance: 0,
    rateHistory: [{ clock, year: eco.year, movePercent: 0, ratePercent: rate.ratePercent }],
    prepayments: [],
    settlement: null,
    createdAt: d.ctx.now,
    closedAt: null,
  };
  eco.loans.push(loan);
  const flags = eco.yearFlags[actor.id];
  if (flags) flags.borrowed = true;
  d.transfer({ type: 'LOAN_DISBURSEMENT', from: null, to: actor.id, amount: input.amount, propertyKey: keys[0] ?? null, memo: `${def.name} at ${rate.ratePercent}%` });
  const first = loan.installments[0]!;
  const secured = keys.length ? `, secured on ${keys.map((key) => getDeed(key).name).join(', ')}` : '';
  d.event('INTERMEDIATE_LOAN_TAKEN', actor.id, `${actor.name} took a ${def.name}: ${formatINR(input.amount)} at ${rate.ratePercent}%${secured}`, {
    loanId: loan.id,
    product: input.product,
    principal: input.amount,
    ratePercent: rate.ratePercent,
    tenureYears: def.tenureYears,
    collateralKey: keys[0] ?? null,
    collateralKeys: keys,
    collateralValue: pledges.reduce((sum, p) => sum + p.propertyValue + p.buildingValue, 0),
    firstPaymentDue: clockLabel(eco, first.dueAt),
    ...(refinancedFrom ? { refinancedFrom } : {}),
  });
  for (const key of keys) closeTradesWith(d, key, 'was pledged as loan collateral');
  return loan;
}

export function takeLoan(d: Draft, actor: PlayerState, input: LoanRequest): void {
  const eco = economy(d);
  const why = loanRequestBlocker(d.state, actor.id, input.product, input.amount, input.collateralKeys);
  if (why) fail('LOAN_NOT_ALLOWED', why);
  originateLoan(d, eco, actor, input, confirmedRate(eco, actor, input), null);
}

/**
 * Refinancing: one active loan is paid off with a new one, in one action. Nothing about the debt is reset:
 *   - the old loan's payoff (principal not yet due + the interest accrued on it this loan year, exactly what an
 *     early repayment in full charges) is paid to the bank from the new loan's money and, if the new loan is
 *     smaller, from the player's cash;
 *   - the old loan closes SETTLED (never REPAID), keeps its history, and earns no credit-score bonus;
 *   - its collateral is released and may be pledged again for the new loan, within the same action — at no
 *     point does a property back two live loans;
 *   - the new loan is an ordinary new loan: every limit, the repayment capacity, the product rules and the
 *     player's current credit band apply (the old loan's principal and payments are what it frees up).
 * Refused while anything is due, overdue or in default — refinancing never clears a missed payment.
 */
export function refinanceLoan(d: Draft, actor: PlayerState, loanId: string, input: LoanRequest): void {
  const eco = economy(d);
  const old = ownLoan(eco, actor, loanId);
  const blocked = refinanceBlocker(eco, actor.id, old.id);
  if (blocked) fail('LOAN_NOT_ALLOWED', blocked);
  const why = loanRequestBlocker(d.state, actor.id, input.product, input.amount, input.collateralKeys, { replacingLoanId: old.id });
  if (why) fail('LOAN_NOT_ALLOWED', why);
  const rate = confirmedRate(eco, actor, input);
  const payoff = prepaymentQuote(eco, old, scheduledPrincipal(old));
  if (actor.balance + input.amount < payoff.principal + payoff.accruedInterest) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — paying off the old loan needs ${formatINR(payoff.total - input.amount)} from your cash.`);
  }
  const oldName = LOANS.products[old.product].name;
  // The old claim ends before the new one is made, inside this one action.
  closeLoan(d, old, 'SETTLED');
  const replacement = originateLoan(d, eco, actor, input, rate, old.id);
  payBank(d, actor, payoff.principal, payoff.accruedInterest, `${oldName} refinanced`);
  old.prepayments.push({ clock: gameClock(eco), year: eco.year, principal: payoff.principal, interest: payoff.accruedInterest });
  old.installments = old.installments.filter((i) => i.status !== 'SCHEDULED');
  old.refinancedInto = replacement.id;
  d.event(
    'LOAN_REFINANCED',
    actor.id,
    `${actor.name} refinanced a ${oldName} (${formatINR(payoff.total)} paid off) with a ${LOANS.products[input.product].name} of ${formatINR(input.amount)}`,
    { loanId: old.id, replacementLoanId: replacement.id, principal: payoff.principal, interest: payoff.accruedInterest, newPrincipal: input.amount },
  );
}

/** A pledged property can't change hands, so open offers that include it are closed. */
function closeTradesWith(d: Draft, key: PropertyKey, why: string): void {
  for (const t of d.state.trades) {
    if (t.status !== 'PENDING' || !(t.offeredPropertyKeys.includes(key) || t.requestedPropertyKeys.includes(key))) continue;
    t.status = 'EXPIRED';
    t.resolvedAt = d.ctx.now;
    d.event('TRADE_EXPIRED', null, `Trade offer from ${d.name(t.fromPlayerId)} to ${d.name(t.toPlayerId)} closed — ${getDeed(key).name} ${why}`, { tradeId: t.id, propertyKey: key });
  }
}

function ownLoan(eco: IntermediateState, actor: PlayerState, loanId: string): IntermediateLoan {
  const loan = eco.loans.find((l) => l.id === loanId);
  if (!loan || loan.playerId !== actor.id) fail('NOT_FOUND', 'Loan not found.');
  return loan;
}

/** Pays principal and interest to the bank as two ledger entries, so the two are never blurred together. */
function payBank(d: Draft, actor: PlayerState, principal: number, interest: number, memo: string): void {
  if (actor.balance < principal + interest) {
    fail('INSUFFICIENT_FUNDS', `Not enough money — you need ${formatINR(principal + interest)}.`);
  }
  if (principal > 0) d.transfer({ type: 'LOAN_REPAYMENT', from: actor.id, to: null, amount: principal, memo: `${memo} — principal` });
  if (interest > 0) d.transfer({ type: 'LOAN_INTEREST', from: actor.id, to: null, amount: interest, memo: `${memo} — interest` });
}

/**
 * A good repayment history on one loan: at least one installment paid on time, and none ever late.
 * Prepaying a loan before anything falls due builds no history, so borrowing and repaying at once
 * can never be used to raise a score.
 */
export function hasGoodRepaymentHistory(loan: IntermediateLoan): boolean {
  return loan.installments.some((i) => i.status === 'PAID') && !loan.installments.some((i) => i.status === 'OVERDUE' || i.status === 'CAUGHT_UP' || i.status === 'DEFAULTED');
}

/** The loan has nothing left on its schedule: it is repaid as agreed. The repayment bonus needs a good history (above). */
function finishIfRepaid(d: Draft, eco: IntermediateState, loan: IntermediateLoan): void {
  if (loan.status !== 'ACTIVE' || loan.installments.some((i) => i.status === 'SCHEDULED' || i.status === 'DUE' || i.status === 'OVERDUE')) return;
  const released = loanCollateralKeys(loan);
  closeLoan(d, loan, 'REPAID');
  const names = released.map((key) => getDeed(key).name).join(', ');
  d.event('INTERMEDIATE_LOAN_REPAID', loan.playerId, `${d.name(loan.playerId)} fully repaid a ${LOANS.products[loan.product].name}${released.length ? ` — ${names} ${released.length === 1 ? 'is' : 'are'} released` : ''}`, {
    loanId: loan.id,
    releasedCollateral: released[0] ?? null,
    releasedCollateralKeys: released,
  });
  if (hasGoodRepaymentHistory(loan)) applyCreditEvent(d, eco, { id: `LOAN_REPAID:${loan.id}`, playerId: loan.playerId, type: 'LOAN_REPAID', loanId: loan.id });
}

/** "Pay now": settles the oldest installment that has fallen due on a loan, in full. */
export function payInstallment(d: Draft, actor: PlayerState, loanId: string): void {
  const eco = economy(d);
  const loan = ownLoan(eco, actor, loanId);
  const installment = payableInstallment(loan);
  if (!installment) fail('LOAN_NOT_ALLOWED', loan.status === 'DEFAULTED' ? 'This loan is in default — pay its balance instead.' : 'No installment is due on this loan right now.');
  const name = LOANS.products[loan.product].name;
  const wasOverdue = installment.status === 'OVERDUE';
  payBank(d, actor, installment.principal, installment.interest, `${name} installment ${installment.index}`);
  installment.status = wasOverdue ? 'CAUGHT_UP' : 'PAID';
  installment.paidAt = gameClock(eco);
  const amount = installment.principal + installment.interest;
  d.event(
    wasOverdue ? 'LOAN_INSTALLMENT_CAUGHT_UP' : 'LOAN_INSTALLMENT_PAID',
    actor.id,
    `${actor.name} paid ${name} installment ${installment.index} (${formatINR(amount)})${wasOverdue ? ' — late, within grace' : ''}`,
    { loanId: loan.id, installment: installment.index, amount, principal: installment.principal, interest: installment.interest },
  );
  // Catching up on an overdue installment stops the damage (no default) but earns nothing back.
  if (!wasOverdue) {
    applyCreditEvent(d, eco, { id: `ON_TIME_PAYMENT:${loan.id}:${installment.index}`, playerId: actor.id, type: 'ON_TIME_PAYMENT', loanId: loan.id });
    const flags = eco.yearFlags[actor.id];
    if (flags) flags.paidOnTime = true;
  } else if (IR.credit.events.CAUGHT_UP !== 0) {
    applyCreditEvent(d, eco, { id: `CAUGHT_UP:${loan.id}:${installment.index}`, playerId: actor.id, type: 'CAUGHT_UP', loanId: loan.id });
  }
  finishIfRepaid(d, eco, loan);
}

/**
 * Early repayment of principal that is not yet due, in part or in full: the player pays that
 * principal plus the interest accrued on it so far this loan year, with no penalty. What is
 * left is re-amortized over the same remaining due dates at the same rate.
 */
export function prepayLoan(d: Draft, actor: PlayerState, loanId: string, principal: number): void {
  const eco = economy(d);
  const loan = ownLoan(eco, actor, loanId);
  const why = prepaymentBlocker(loan, principal);
  if (why) fail('LOAN_NOT_ALLOWED', why);
  const quote = prepaymentQuote(eco, loan, principal);
  const name = LOANS.products[loan.product].name;
  payBank(d, actor, quote.principal, quote.accruedInterest, `${name} early repayment`);
  loan.prepayments.push({ clock: gameClock(eco), year: eco.year, principal: quote.principal, interest: quote.accruedInterest });
  if (quote.remainingPrincipal === 0) {
    loan.installments = loan.installments.filter((i) => i.status !== 'SCHEDULED');
  } else {
    reschedule(loan, quote.remainingPrincipal);
  }
  d.event('LOAN_PREPAID', actor.id, `${actor.name} repaid ${formatINR(quote.principal)} of a ${name} early (+ ${formatINR(quote.accruedInterest)} interest)`, {
    loanId: loan.id,
    principal: quote.principal,
    interest: quote.accruedInterest,
    remainingPrincipal: quote.remainingPrincipal,
  });
  finishIfRepaid(d, eco, loan);
}

/** Pays down a defaulted loan's balance, in any amount. Clearing it lifts the borrowing block. */
export function payDefaultedLoan(d: Draft, actor: PlayerState, loanId: string, amount: number): void {
  const eco = economy(d);
  const loan = ownLoan(eco, actor, loanId);
  if (loan.status !== 'DEFAULTED') fail('LOAN_NOT_ALLOWED', 'This loan is not in default.');
  if (amount > loan.defaultBalance) fail('VALIDATION', `You only owe ${formatINR(loan.defaultBalance)} on this loan.`);
  if (actor.balance < amount) fail('INSUFFICIENT_FUNDS', 'Not enough money to pay that much.');
  d.transfer({ type: 'LOAN_REPAYMENT', from: actor.id, to: null, amount, memo: `${LOANS.products[loan.product].name} — defaulted balance` });
  loan.defaultBalance -= amount;
  const cleared = loan.defaultBalance === 0;
  if (cleared) closeLoan(d, loan, 'SETTLED');
  d.event('LOAN_DEFAULT_PAYMENT', actor.id, `${actor.name} paid ${formatINR(amount)} towards a defaulted loan${cleared ? ' — default cleared' : ''}`, {
    loanId: loan.id,
    amount,
    remaining: loan.defaultBalance,
  });
}
