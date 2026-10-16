import {
  BUSINESS_MVP_RULES as RULES,
  canBorrow,
  classicLoanStanding,
  collateralLimit,
  configOf,
  economyOf,
  formatINR,
  getDeed,
  insuranceQuote,
  INTERMEDIATE_RULES as IR,
  isEnforceableLoan,
  loanOffers,
  loansOf,
  outstandingPrincipal,
  ownedBy,
  payableInstallment,
  prepaymentBlocker,
  renewalBlocker,
  renewalOffer,
  scheduledPrincipal,
  uninsuredProperties,
  type CollateralOption,
  type GameAction,
  type GameState,
  type PaymentReason,
  type PropertyKey,
} from '../engine/index.ts';
import { BOT_POLICY } from './config.ts';
import { actionKey, evaluate, type Scored } from './scoring.ts';
import { weigh, type Assessment, type ValuationContext } from './valuation.ts';

/** The action that settles each kind of payment the turn can wait on. */
export const PAY_ACTION: Record<PaymentReason, 'PAY_RENT' | 'PAY_TAX' | 'PAY_CARD' | 'PAY_INTEREST' | 'PAY_CLUB'> = {
  RENT: 'PAY_RENT',
  TAX: 'PAY_TAX',
  CARD: 'PAY_CARD',
  LOAN_INTEREST: 'PAY_INTEREST',
  CLUB: 'PAY_CLUB',
};

const roundUp = (amount: number, step: number) => Math.ceil(amount / step) * step;

// ---------------------------------------------------------------------------
// Borrowing
// ---------------------------------------------------------------------------

/** The fewest pledges (largest first) whose pooled value secures `amount`, or null if everything together can't. */
export function chooseCollateral(options: readonly CollateralOption[], amount: number): PropertyKey[] | null {
  const sorted = [...options].sort((a, b) => b.value - a.value);
  const keys: PropertyKey[] = [];
  let pool = 0;
  for (const option of sorted) {
    keys.push(option.key);
    pool += option.value;
    if (collateralLimit(pool) >= amount) return keys;
  }
  return null;
}

/**
 * Loans the bank would give this bot for `need` rupees, as ready-to-send actions: Classic's one fixed-rate
 * loan, or each Capital product it is offered (the engine's own offers: rate, limits, collateral, repayment
 * capacity). Whether a loan is worth taking is the caller's scoring; here only what may be asked for.
 */
export function loanCandidates(vc: ValuationContext, need: number): GameAction[] {
  const s = vc.obs.state;
  const me = vc.obs.botId;
  const out: GameAction[] = [];
  if (!economyOf(s)) {
    if (!canBorrow(s, me)) return out;
    const rules = RULES.loans;
    const room = configOf(s).loanLimit - outstandingPrincipal(s.loans, me);
    for (const want of [need, need + vc.reserveBase / 2]) {
      const amount = Math.max(rules.minAmount, roundUp(Math.max(0, want), rules.step));
      if (amount <= room && !out.some((a) => a.type === 'REQUEST_LOAN' && a.amount === amount)) out.push({ type: 'REQUEST_LOAN', amount });
    }
    return out;
  }
  const L = IR.loans;
  for (const offer of loanOffers(s, me)) {
    if (offer.blocked || offer.maxAmount < L.minAmount) continue;
    const amount = Math.min(offer.maxAmount, Math.max(L.minAmount, roundUp(Math.max(0, need), L.step)));
    if (offer.secured) {
      const keys = chooseCollateral(offer.collateral, amount);
      if (!keys) continue;
      out.push({ type: 'TAKE_INTERMEDIATE_LOAN', product: offer.product, amount, collateralKeys: keys, expectedRatePercent: offer.ratePercent });
    } else {
      out.push({ type: 'TAKE_INTERMEDIATE_LOAN', product: offer.product, amount, expectedRatePercent: offer.ratePercent });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raising money for a payment that is due
// ---------------------------------------------------------------------------

/** Every one-step way of raising cash the engine might allow: sell a building, mortgage, sell to the bank, borrow. */
export function raiseCashCandidates(vc: ValuationContext, shortfall: number, allowLoans: boolean): GameAction[] {
  const out: GameAction[] = [];
  for (const key of ownedBy(vc.obs.state, vc.obs.botId)) {
    out.push({ type: 'SELL_BUILDING', propertyKey: key }, { type: 'MORTGAGE_PROPERTY', propertyKey: key }, { type: 'SELL_PROPERTY', propertyKey: key });
  }
  if (allowLoans) out.push(...loanCandidates(vc, shortfall));
  return out;
}

/**
 * The least harmful legal way to raise money towards `shortfall`: for each option the engine accepts, the
 * value it destroys (everything but the liquidity it restores, personality-weighted) per rupee it raises
 * towards the shortfall. Mortgaging a quiet property is usually cheapest; selling a hotel back at half its
 * cost, or borrowing at interest, only when nothing gentler is left.
 */
export function pickRecovery(vc: ValuationContext, base: Assessment, shortfall: number, candidates: readonly GameAction[], exclude?: ReadonlySet<string>): Scored | null {
  let top: { scored: Scored; cost: number; raised: number } | null = null;
  for (const action of candidates) {
    const scored = evaluate(vc, base, action, 'raise money', vc.obs.state, exclude);
    if (!scored) continue;
    const raised = scored.afterAssessment.cash - base.cash;
    if (raised <= 0) continue;
    const destroyed = Math.max(0, -weigh(vc, { ...scored.components, liquidity: 0 }));
    const cost = destroyed / Math.min(raised, Math.max(1, shortfall));
    if (!top || cost < top.cost - 1e-9 || (Math.abs(cost - top.cost) <= 1e-9 && raised > top.raised)) top = { scored, cost, raised };
  }
  if (!top) return null;
  return { ...top.scored, note: `raises ${formatINR(top.raised)} at the least cost (${(top.cost * 100).toFixed(0)}% of what it raises)` };
}

// ---------------------------------------------------------------------------
// Obligations that are not the turn's payment
// ---------------------------------------------------------------------------

export interface Planned {
  action: GameAction;
  kind: string;
  reason: string;
}

/**
 * Loan obligations, in priority order: Capital installments that have fallen due (late ones first), Classic
 * principal that has fallen due (before the next Start makes it overdue or defaulted), and balances in
 * default once that leaves a sensible reserve. Only what the cash on hand covers: an obligation that is not
 * the turn's payment never forces a sale by itself.
 */
export function obligationAction(vc: ValuationContext, exclude?: ReadonlySet<string>): Planned | null {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const ok = (a: GameAction) => !exclude?.has(actionKey(a));
  const eco = economyOf(s);
  if (eco) {
    const loans = loansOf(eco, me.id);
    const due = loans
      .map((loan) => ({ loan, installment: payableInstallment(loan) }))
      .filter((x) => x.installment)
      .sort((a, b) => (a.installment!.status === 'OVERDUE' ? 0 : 1) - (b.installment!.status === 'OVERDUE' ? 0 : 1) || a.installment!.dueAt - b.installment!.dueAt);
    for (const { loan, installment } of due) {
      const amount = installment!.principal + installment!.interest;
      const action: GameAction = { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id };
      if (me.balance >= amount && ok(action)) {
        return { action, kind: 'PAY_INSTALLMENT', reason: `Pays a ${installment!.status === 'OVERDUE' ? 'late' : 'due'} loan installment of ${formatINR(amount)} to protect its credit score.` };
      }
    }
    for (const loan of loans) {
      if (loan.status !== 'DEFAULTED' || loan.defaultBalance <= 0) continue;
      const amount = Math.min(loan.defaultBalance, me.balance - vc.reserveBase);
      const action: GameAction = { type: 'PAY_DEFAULTED_LOAN', loanId: loan.id, amount: Math.floor(amount) };
      if (amount >= Math.min(loan.defaultBalance, 1000) && ok(action)) return { action, kind: 'PAY_DEFAULT', reason: 'Pays down a loan in default to lift the borrowing block.' };
    }
    return null;
  }
  for (const loan of s.loans) {
    if (loan.playerId !== me.id || !isEnforceableLoan(loan) || loan.outstanding <= 0) continue;
    const standing = classicLoanStanding(loan, me.circuits);
    const action: GameAction = { type: 'REPAY_LOAN', loanId: loan.id, amount: loan.outstanding };
    if (!ok(action)) continue;
    if ((standing === 'DUE' || standing === 'OVERDUE') && me.balance >= loan.outstanding) {
      return { action, kind: 'REPAY_DUE_LOAN', reason: `Repays a bank loan of ${formatINR(loan.outstanding)} that has fallen due, before it defaults.` };
    }
    if (standing === 'DEFAULTED' && me.balance - loan.outstanding >= vc.reserveBase) {
      return { action, kind: 'REPAY_DEFAULTED_LOAN', reason: 'Clears a defaulted bank loan to be able to borrow again.' };
    }
  }
  return null;
}

/** What a player owes on Capital installments that are already overdue (0 in Classic). */
export function overdueInstallmentAmount(state: GameState, playerId: string): number {
  const eco = economyOf(state);
  if (!eco) return 0;
  return loansOf(eco, playerId)
    .filter((l) => l.status === 'ACTIVE')
    .reduce((s, l) => s + l.installments.filter((i) => i.status === 'OVERDUE').reduce((t, i) => t + i.principal + i.interest, 0), 0);
}

/** Cheap check: could obligationAction have anything to do for this player? (Avoids building a valuation off-turn.) */
export function hasLoanObligation(state: GameState, playerId: string): boolean {
  const eco = economyOf(state);
  if (eco) return loansOf(eco, playerId).some((l) => l.status === 'DEFAULTED' || payableInstallment(l) !== null);
  const circuits = state.players.find((p) => p.id === playerId)?.circuits ?? 0;
  return state.loans.some((l) => l.playerId === playerId && ['DUE', 'OVERDUE', 'DEFAULTED'].includes(classicLoanStanding(l, circuits)));
}

// ---------------------------------------------------------------------------
// Optional financial moves (scored like everything else)
// ---------------------------------------------------------------------------

/** Voluntary repayments and insurance this bot could make now, as actions for the scorer. */
export function optionalFinanceCandidates(vc: ValuationContext): GameAction[] {
  const s = vc.obs.state;
  const me = vc.obs.me;
  const out: GameAction[] = [];
  const eco = economyOf(s);
  const spare = me.balance - vc.reserveBase;
  if (!eco) {
    for (const loan of s.loans) {
      if (loan.playerId !== me.id || loan.status !== 'ACTIVE' || loan.outstanding <= 0) continue;
      if (me.balance >= loan.outstanding) out.push({ type: 'REPAY_LOAN', loanId: loan.id, amount: loan.outstanding });
      const part = Math.floor(Math.min(loan.outstanding - 1, spare) / 500) * 500;
      if (part >= 500) out.push({ type: 'REPAY_LOAN', loanId: loan.id, amount: part });
    }
    return out;
  }
  for (const loan of loansOf(eco, me.id)) {
    if (loan.status !== 'ACTIVE') continue;
    const scheduled = scheduledPrincipal(loan);
    for (const principal of [scheduled, Math.floor(Math.min(scheduled, spare) / IR.loans.step) * IR.loans.step]) {
      if (principal > 0 && !prepaymentBlocker(loan, principal) && !out.some((a) => a.type === 'PREPAY_INTERMEDIATE_LOAN' && a.loanId === loan.id && a.amount === principal)) {
        out.push({ type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: principal });
      }
    }
  }
  if (eco.insurance) {
    const uninsured = uninsuredProperties(s, me.id);
    if (uninsured.length > 0) {
      out.push({ type: 'INSURE_PROPERTIES', propertyKeys: uninsured, expectedPremium: insuranceQuote({ year: eco.year, properties: uninsured.length }).premium });
      for (const key of uninsured) out.push({ type: 'INSURE_PROPERTY', propertyKey: key, expectedPremium: insuranceQuote({ year: eco.year, properties: 1 }).premium });
    }
    for (const policy of eco.insurance.policies) {
      if (policy.ownerId !== me.id || renewalBlocker(s, me.id, policy.id)) continue;
      const offer = renewalOffer(s, policy);
      if (offer) out.push({ type: 'RENEW_INSURANCE', policyId: policy.id, expectedPremium: offer.pricing.premium });
    }
  }
  return out;
}

/** "Mumbai" or "3 properties" — for explanations. */
export function propertiesLabel(keys: readonly PropertyKey[]): string {
  return keys.length === 1 ? getDeed(keys[0]!).name : `${keys.length} properties`;
}

export const MIN_IMPROVEMENT = BOT_POLICY.decisions.minimumImprovement;
