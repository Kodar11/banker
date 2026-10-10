import { getDeed, PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';
import type { Draft } from './draft.ts';
import { fail } from './errors.ts';
import { formatINR } from './format.ts';
import { configOf } from './gameConfig.ts';
import { INTERMEDIATE_RULES as IR, type CreditEventType, type LoanProductKey } from './intermediateConfig.ts';
import {
  accruedInterest,
  applyMarketChange,
  buildSchedule,
  clampScore,
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
} from './intermediateSelectors.ts';
import {
  economyOf,
  gameClock,
  isOpenLoan,
  loansOf,
  scheduledPrincipal,
  unpaidInstallments,
  yearAt,
  yearLength,
  type IntermediateLoan,
  type IntermediateState,
  type MarketEntry,
  type YearReport,
} from './intermediateState.ts';
import type { PlayerState } from './types.ts';

/**
 * Intermediate Mode's state transitions. Every function works on the action's Draft, so
 * whatever it changes — economy, balances, ledger, events — commits with that action or
 * not at all, under the same game lock and the same exactly-once action id as any other move.
 *
 * The reducer calls in here only for Intermediate games; a Classic game never reaches this file.
 */

const LOANS = IR.loans;

function economy(d: Draft): IntermediateState {
  const eco = economyOf(d.state);
  if (!eco) fail('LOAN_NOT_ALLOWED', 'This is only available in Intermediate Mode.');
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
 * is ignored, so no event can ever move a score twice.
 */
function applyCreditEvent(d: Draft, eco: IntermediateState, input: { id: string; playerId: string; type: CreditEventType; loanId: string | null }): void {
  if (eco.creditEvents.some((e) => e.id === input.id)) return;
  const before = creditScoreOf(eco, input.playerId);
  const delta = IR.credit.events[input.type];
  const after = clampScore(before + delta);
  eco.credit[input.playerId] = after;
  const reason = CREDIT_REASONS[input.type];
  eco.creditEvents.push({ ...input, delta, before, after, year: eco.year, reason, createdAt: d.ctx.now });
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
 * Creates the game's economy when an Intermediate game starts: Year 1, every property at its
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
 *   4. each year that ended pays its clean-year credit reward and is announced.
 *
 * Only dice movement counts. Card moves, Jail and Rest House placements, reconnects and retried
 * requests never reach this function, so they can never advance the calendar.
 */
export function recordDiceMovement(d: Draft, player: PlayerState, spaces: number): void {
  const eco = economyOf(d.state);
  if (!eco || spaces <= 0 || !(player.id in eco.movement)) return;
  eco.movement[player.id] = (eco.movement[player.id] ?? 0) + spaces;
  const target = yearAt(eco, gameClock(eco));
  const reports: YearReport[] = [];
  while (eco.year < target) reports.push(startNextYear(d, eco));
  processLoanCheckpoints(d, eco);
  for (const report of reports) closeYear(d, eco, report);
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

/** After the year's loan checkpoints: clean-year rewards, fresh flags for the new year, and the announcement. */
function closeYear(d: Draft, eco: IntermediateState, report: YearReport): void {
  const ended = report.year - 1;
  for (const player of d.activePlayers()) {
    const flags = eco.yearFlags[player.id];
    if (!flags) continue;
    const clean = flags.borrowed && !flags.late && !hasCreditProblem(eco, player.id);
    if (clean) applyCreditEvent(d, eco, { id: `CLEAN_YEAR:${player.id}:${ended}`, playerId: player.id, type: 'CLEAN_YEAR', loanId: null });
    eco.yearFlags[player.id] = { borrowed: loansOf(eco, player.id).some(isOpenLoan), late: hasCreditProblem(eco, player.id) };
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
 * A secured loan's property goes to the bank at its market value today; that value is set
 * against the debt, any surplus is paid to the borrower, any shortfall stays owed.
 * An unsecured loan seizes nothing. Either way the borrower is not bankrupt.
 */
function defaultLoan(d: Draft, eco: IntermediateState, loan: IntermediateLoan): void {
  const clock = gameClock(eco);
  const length = yearLength(eco);
  const due = unpaidInstallments(loan).reduce((sum, i) => sum + i.principal + i.interest, 0);
  const notYetDue = scheduledPrincipal(loan);
  const next = loan.installments.find((i) => i.status === 'SCHEDULED');
  const accrued = next ? accruedInterest(notYetDue, loan.ratePercent, clock - (next.dueAt - length), length) : 0;
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

  const key = loan.collateralKey;
  if (key) {
    const prop = d.state.properties[key];
    const value = eco.market[key].value;
    const { applied, surplus, remaining } = settleCollateral(value, loan.defaultBalance);
    // The claim and the property move together, once: after this the loan holds no collateral.
    loan.collateralKey = null;
    loan.settlement = { propertyKey: key, value, applied, surplus };
    loan.defaultBalance = remaining;
    prop.ownerId = null;
    prop.houses = 0;
    prop.hotel = false;
    prop.mortgaged = false;
    if (surplus > 0) {
      d.transfer({ type: 'COLLATERAL_SURPLUS', from: null, to: loan.playerId, amount: surplus, propertyKey: key, memo: `Collateral surplus (${getDeed(key).name})` });
    }
    d.event(
      'COLLATERAL_SEIZED',
      loan.playerId,
      `The bank took ${getDeed(key).name} (worth ${formatINR(value)}) for ${d.name(loan.playerId)}'s defaulted loan` +
        (surplus > 0 ? ` and returned ${formatINR(surplus)}` : remaining > 0 ? ` — ${formatINR(remaining)} still owed` : ''),
      { loanId: loan.id, propertyKey: key, value, applied, surplus, remaining },
    );
    // Ownership changed under any earlier action: none of them can be compensated safely any more.
    d.state.undoStack = [];
    d.state.undoRequest = null;
  }
  if (loan.defaultBalance === 0) closeLoan(d, loan, 'SETTLED');
}

function closeLoan(d: Draft, loan: IntermediateLoan, status: 'REPAID' | 'SETTLED' | 'WRITTEN_OFF'): void {
  loan.status = status;
  loan.collateralKey = null;
  loan.closedAt = d.ctx.now;
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

export function takeLoan(
  d: Draft,
  actor: PlayerState,
  input: { product: LoanProductKey; amount: number; collateralKey: PropertyKey | null; expectedRatePercent: number },
): void {
  const eco = economy(d);
  const why = loanRequestBlocker(d.state, actor.id, input.product, input.amount, input.collateralKey);
  if (why) fail('LOAN_NOT_ALLOWED', why);
  const def = LOANS.products[input.product];
  const rate = offeredRate(input.product, creditScoreOf(eco, actor.id));
  // The contract the player confirmed must be the contract they get.
  if (rate.ratePercent !== input.expectedRatePercent) {
    fail('STALE_STATE', `Your offer changed: the rate is now ${rate.ratePercent}%. Review the terms and confirm again.`);
  }
  const clock = gameClock(eco);
  const length = yearLength(eco);
  const loan: IntermediateLoan = {
    id: d.ctx.newId(),
    playerId: actor.id,
    product: input.product,
    principal: input.amount,
    ...rate,
    rateType: def.rateType,
    tenureYears: def.tenureYears,
    collateralKey: def.secured ? input.collateralKey : null,
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
  d.transfer({ type: 'LOAN_DISBURSEMENT', from: null, to: actor.id, amount: input.amount, propertyKey: loan.collateralKey, memo: `${def.name} at ${rate.ratePercent}%` });
  const first = loan.installments[0]!;
  const secured = loan.collateralKey ? `, secured on ${getDeed(loan.collateralKey).name}` : '';
  d.event('INTERMEDIATE_LOAN_TAKEN', actor.id, `${actor.name} took a ${def.name}: ${formatINR(input.amount)} at ${rate.ratePercent}%${secured}`, {
    loanId: loan.id,
    product: input.product,
    principal: input.amount,
    ratePercent: rate.ratePercent,
    tenureYears: def.tenureYears,
    collateralKey: loan.collateralKey,
    firstPaymentDue: clockLabel(eco, first.dueAt),
  });
  if (loan.collateralKey) closeTradesWith(d, loan.collateralKey, 'was pledged as loan collateral');
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

/** The loan has nothing left on its schedule: it is repaid as agreed. */
function finishIfRepaid(d: Draft, eco: IntermediateState, loan: IntermediateLoan): void {
  if (loan.status !== 'ACTIVE' || loan.installments.some((i) => i.status === 'SCHEDULED' || i.status === 'DUE' || i.status === 'OVERDUE')) return;
  const released = loan.collateralKey;
  closeLoan(d, loan, 'REPAID');
  d.event('INTERMEDIATE_LOAN_REPAID', loan.playerId, `${d.name(loan.playerId)} fully repaid a ${LOANS.products[loan.product].name}${released ? ` — ${getDeed(released).name} is released` : ''}`, {
    loanId: loan.id,
    releasedCollateral: released,
  });
  applyCreditEvent(d, eco, { id: `LOAN_REPAID:${loan.id}`, playerId: loan.playerId, type: 'LOAN_REPAID', loanId: loan.id });
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
  applyCreditEvent(d, eco, {
    id: `${wasOverdue ? 'CAUGHT_UP' : 'ON_TIME_PAYMENT'}:${loan.id}:${installment.index}`,
    playerId: actor.id,
    type: wasOverdue ? 'CAUGHT_UP' : 'ON_TIME_PAYMENT',
    loanId: loan.id,
  });
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

/**
 * Bankruptcy (decided by the game's own rules, never by a default): the bankrupt player's loans
 * are written off and their collateral claims dropped, as their properties return to the bank.
 */
export function writeOffLoans(d: Draft, playerId: string): void {
  const eco = economyOf(d.state);
  if (!eco) return;
  for (const loan of loansOf(eco, playerId)) {
    if (isOpenLoan(loan)) closeLoan(d, loan, 'WRITTEN_OFF');
  }
}
