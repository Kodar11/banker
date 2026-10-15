import { getDeed, PROPERTY_KEYS, type PropertyKey } from './businessBoard.ts';
import type { Draft } from './draft.ts';
import { formatINR } from './format.ts';
import { configOf } from './gameConfig.ts';
import { INTERMEDIATE_RULES as IR } from './intermediateConfig.ts';
import { settleCollateral } from './intermediateFinance.ts';
import { loanOffers } from './intermediateSelectors.ts';
import { economyOf, isOpenLoan, loanPayoff, loansOf, pendingCrises, type IntermediateLoan } from './intermediateState.ts';
import type { CrisisRecord } from './insuranceState.ts';
import { BUSINESS_MVP_RULES as RULES } from './rules.ts';
import {
  classicBorrowingBlock,
  isEnforceableLoan,
  loanInterestUnpaid,
  mandatoryPaymentsOwed,
  ownedBy,
  outstandingPrincipal,
  propertyActionBlocker,
  raisableFunds,
  sellBuildingRefund,
} from './selectors.ts';
import type { GameState, LoanState, Pending, PlayerState, TransactionType } from './types.ts';

/**
 * Insolvency and departure: who may go bankrupt, and what happens to a player's estate when they go
 * bankrupt or leave. One settlement for both, so neither can be used to dodge what the other collects.
 *
 * Enforceable claims are the game's own: a payment the game asked for (rent, tax, a card, Club, loan
 * interest, a crisis bill) and the bank's loans. Money players lend each other informally, and gifts,
 * are not claims: the game never collects them (docs/economy-rules.md).
 */

type PaymentPending = Extract<Pending, { kind: 'PAYMENT' }>;

/** The ledger type of each payment the turn can wait on. */
export const PAYMENT_TX = {
  RENT: 'RENT_PAYMENT',
  TAX: 'TAX_PAYMENT',
  CARD: 'CARD_PAYMENT',
  LOAN_INTEREST: 'LOAN_INTEREST',
  CLUB: 'CLUB_PAYMENT',
} as const satisfies Record<PaymentPending['reason'], TransactionType>;

// ---------------------------------------------------------------------------
// Raising money, and when bankruptcy is allowed
// ---------------------------------------------------------------------------

/** Whether the bank would lend this player anything right now. Borrowing is an option, never a requirement. */
export function canBorrow(state: GameState, playerId: string): boolean {
  const player = state.players.find((p) => p.id === playerId);
  if (state.status !== 'ACTIVE' || player?.status !== 'ACTIVE') return false;
  if (economyOf(state)) return loanOffers(state, playerId).some((o) => !o.blocked && o.maxAmount >= IR.loans.minAmount);
  if (classicBorrowingBlock(state, playerId)) return false;
  return configOf(state).loanLimit - outstandingPrincipal(state.loans, playerId) >= RULES.loans.minAmount;
}

/** The ways this player could raise money right now, in words, liquidation first. A loan is listed when one is on offer, as an option. */
export function raiseFundsOptions(state: GameState, playerId: string): string[] {
  const owned = ownedBy(state, playerId);
  const can = (kind: 'SELL_BUILDING' | 'MORTGAGE_PROPERTY' | 'SELL_PROPERTY') => owned.some((k) => propertyActionBlocker(state, playerId, k, kind) === null);
  const options: string[] = [];
  if (can('SELL_BUILDING')) options.push('sell a building');
  if (can('MORTGAGE_PROPERTY')) options.push('mortgage a property');
  if (can('SELL_PROPERTY')) options.push('sell a property to the bank');
  if (canBorrow(state, playerId)) options.push('take a loan (optional)');
  return options;
}

/**
 * Why this player may not declare bankruptcy over `owed` right now, or null when they may.
 *
 * Being short of cash is not enough. Bankruptcy is allowed only when even selling every building and
 * mortgaging (or selling) every property to the bank, at the bank's own prices, would not cover what
 * is owed (raisableFunds). Borrowing never counts: a player is never forced into a loan to stay in the
 * game. Every means counted here is one the player can actually use at that moment, so a player who
 * may not declare bankruptcy can always raise the money — nobody is ever left stuck.
 */
export function bankruptcyBlocker(state: GameState, playerId: string, owed: number): string | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 'You are not in this game.';
  if (owed <= 0) return 'You do not owe a payment.';
  if (player.balance >= owed) return 'You can afford this payment.';
  if (raisableFunds(state, playerId) < owed) return null;
  const ways = raiseFundsOptions(state, playerId).filter((o) => !o.startsWith('take a loan'));
  return `You can still raise the ${formatINR(owed)}: ${ways.join(', ')}. Bankruptcy is only possible when even that would not be enough.`;
}

/** bankruptcyBlocker for everything the player owes right now (the turn's payment and any crisis bill). */
export function bankruptcyBlockerNow(state: GameState, playerId: string): string | null {
  return bankruptcyBlocker(state, playerId, mandatoryPaymentsOwed(state, playerId));
}

// ---------------------------------------------------------------------------
// Settling an estate
// ---------------------------------------------------------------------------

export type EstateKind = 'BANKRUPTCY' | 'DEPARTURE';

/** What started the settlement and is paid first: the payment the turn was waiting on, or a crisis bill. */
export type EstateTrigger = { kind: 'TURN' } | { kind: 'CRISIS'; crisisId: string } | null;

interface Claim {
  kind: 'PAYMENT' | 'CRISIS' | 'LOAN';
  label: string;
  /** Players owed (an empty list: the bank). */
  creditorIds: string[];
  /** What is still owed. Read when its turn comes, so an earlier claim it overlaps with (loan interest) is never counted twice. */
  owed(): number;
  pay(amount: number): void;
  /** Records the outcome on the claim's own record, once, with what is left unpaid. */
  close(unpaid: number): void;
}

export interface ClaimResult {
  kind: Claim['kind'];
  label: string;
  creditorIds: string[];
  owed: number;
  paid: number;
  unpaid: number;
}

export interface EstateOutcome {
  claims: ClaimResult[];
  /** The first claim (the payment that triggered the settlement) was paid in full. */
  triggerPaid: boolean;
  /** Raised by selling buildings and property to the bank. */
  liquidation: number;
  /** Cash left over after every claim, taken out of play. */
  residual: number;
  /** Every claim's unpaid part, added up. */
  unpaid: number;
}

/**
 * THE settlement of a player's estate, when they go bankrupt or leave. One action, one order:
 *
 *   1. Pledged collateral (Capital): each secured loan takes its own property at today's market value;
 *      any surplus is the player's cash, any shortfall stays on that loan.
 *   2. Claims, in this order: the payment that triggered the settlement; the rest of what the turn
 *      was waiting on; other crisis bills (oldest first); the bank's loans (oldest first — Classic:
 *      interest charged and unpaid, then principal; Capital: each loan's payoff, interest first).
 *   3. If the cash does not cover them, the estate raises money exactly as the player could have: every
 *      building sold back to the bank, then unmortgaged, unpledged property sold to the bank at its
 *      mortgage value — in board order, and only as far as needed.
 *   4. The cash is paid out claim by claim; a claim that cannot be paid in full gets what is left.
 *      A payment owed to several players is shared equally (whole rupees; any odd rupees go one each
 *      to the first payees in turn order).
 *   5. Cash left over leaves play (to the bank): opponents never inherit it.
 *   6. Every property still in the player's name returns to the bank: no buildings, no mortgage,
 *      ready to be bought or auctioned in the ordinary way.
 *
 * Every rupee moves through Draft.transfer, so the ledger has a row for it. Nothing else is invented
 * or forgiven: what could not be paid is recorded on the claim itself (a loan written off with its
 * unpaid amount, a crisis bill left UNPAID) and in the ESTATE_SETTLED event. Called once per player:
 * the callers run it only while the player is still ACTIVE, and the same action takes them out.
 */
export function settleEstate(d: Draft, player: PlayerState, kind: EstateKind, trigger: EstateTrigger): EstateOutcome {
  const covered = seizeCollateral(d, player);
  const claims = estateClaims(d, player, kind, trigger, covered);
  const owedTotal = () => claims.reduce((sum, c) => sum + c.owed(), 0);
  const liquidation = player.balance < owedTotal() ? liquidate(d, player, owedTotal()) : 0;

  const results: ClaimResult[] = [];
  for (const claim of claims) {
    const owed = claim.owed();
    const paid = Math.min(owed, player.balance);
    if (paid > 0) claim.pay(paid);
    claim.close(owed - paid);
    results.push({ kind: claim.kind, label: claim.label, creditorIds: claim.creditorIds, owed, paid, unpaid: owed - paid });
  }

  const residual = player.balance;
  if (residual > 0) {
    d.transfer({ type: 'ESTATE_SETTLEMENT', from: player.id, to: null, amount: residual, memo: `${kind === 'BANKRUPTCY' ? 'Bankruptcy' : 'Left the game'}: remaining cash leaves play` });
  }
  const returned = returnPropertiesToBank(d, player.id);
  const outcome: EstateOutcome = {
    claims: results,
    triggerPaid: trigger === null || (results[0]?.unpaid ?? 0) === 0,
    liquidation,
    residual,
    unpaid: results.reduce((sum, r) => sum + r.unpaid, 0),
  };
  const unpaid = outcome.unpaid > 0 ? ` — ${formatINR(outcome.unpaid)} could not be paid` : '';
  d.event('ESTATE_SETTLED', player.id, `${player.name}'s estate was settled${unpaid}`, {
    kind,
    claims: results,
    creditorIds: [...new Set(results.flatMap((r) => r.creditorIds))],
    liquidation,
    residual,
    unpaid: outcome.unpaid,
    propertiesReturned: returned,
  });
  return outcome;
}

function estateClaims(d: Draft, player: PlayerState, kind: EstateKind, trigger: EstateTrigger, covered: ReadonlyMap<string, number>): Claim[] {
  const claims: Claim[] = [];
  const turn = d.state.turn;
  const onTurn = turn.playerId === player.id && turn.pending?.kind === 'PAYMENT' ? turn.pending : null;
  const crises = pendingCrises(d.state).filter((c) => c.ownerId === player.id);
  const first = trigger?.kind === 'CRISIS' ? crises.find((c) => c.id === trigger.crisisId) : undefined;
  if (trigger?.kind === 'TURN' && onTurn) claims.push(paymentClaim(d, player, onTurn, kind));
  if (first) claims.push(crisisClaim(d, player, first, kind));
  if (onTurn && trigger?.kind !== 'TURN') claims.push(paymentClaim(d, player, onTurn, kind));
  // A payment queued behind loan interest (a card's charge) is owed just the same.
  const queued = turn.playerId === player.id && turn.followUp?.kind === 'PAYMENT' && turn.followUp.pending.kind === 'PAYMENT' ? turn.followUp.pending : null;
  if (queued) claims.push(paymentClaim(d, player, queued, kind));
  for (const crisis of crises) if (crisis !== first) claims.push(crisisClaim(d, player, crisis, kind));
  const eco = economyOf(d.state);
  if (eco) {
    for (const loan of loansOf(eco, player.id)) if (isOpenLoan(loan)) claims.push(capitalLoanClaim(d, player, loan, covered.get(loan.id) ?? 0));
  } else {
    // Interest charged at Start that the turn is waiting on is already a claim of its own (above): the loan's claim is its principal.
    const interestClaimed = new Set([onTurn, queued].flatMap((p) => (p?.reason === 'LOAN_INTEREST' ? (p.loanIds ?? []) : [])));
    for (const loan of d.state.loans) if (loan.playerId === player.id && isEnforceableLoan(loan)) claims.push(classicLoanClaim(d, player, loan, interestClaimed.has(loan.id)));
  }
  return claims;
}

/** A payment the turn was waiting on. Paid in full, it is the ordinary payment; part-paid, it is a settlement. */
function paymentClaim(d: Draft, player: PlayerState, pending: PaymentPending, kind: EstateKind): Claim {
  const payees = pending.payeeIds?.length ? [...pending.payeeIds] : null;
  let owed = pending.amount;
  return {
    kind: 'PAYMENT',
    label: pending.label,
    creditorIds: payees ?? (pending.toPlayerId ? [pending.toPlayerId] : []),
    owed: () => owed,
    pay(amount) {
      const full = amount === owed;
      const type: TransactionType = full ? PAYMENT_TX[pending.reason] : 'BANKRUPTCY_SETTLEMENT';
      const memo = full ? pending.label : `${kind === 'BANKRUPTCY' ? 'Bankruptcy' : 'Left the game'}: part of ${pending.label}`;
      if (pending.reason === 'LOAN_INTEREST') {
        d.transfer({ type: 'LOAN_INTEREST', from: player.id, to: null, amount, memo });
        creditInterest(d, pending.loanIds ?? [], amount);
      } else if (payees) {
        const share = Math.floor(amount / payees.length);
        const odd = amount - share * payees.length;
        payees.forEach((id, i) => {
          const part = share + (i < odd ? 1 : 0);
          if (part > 0) d.transfer({ type, from: player.id, to: id, amount: part, memo });
        });
      } else {
        d.transfer({ type, from: player.id, to: pending.toPlayerId, amount, propertyKey: pending.propertyKey, memo });
      }
      owed -= amount;
    },
    close: () => {},
  };
}

/** Loan interest paid on Classic loans, oldest first, never more than each one was charged. */
function creditInterest(d: Draft, loanIds: readonly string[], amount: number): void {
  let left = amount;
  for (const id of loanIds) {
    const loan = d.state.loans.find((l) => l.id === id);
    if (!loan || left <= 0) continue;
    const part = Math.min(left, loanInterestUnpaid(loan));
    loan.interestPaid += part;
    left -= part;
  }
}

function crisisClaim(d: Draft, player: PlayerState, crisis: CrisisRecord, kind: EstateKind): Claim {
  const name = crisis.propertyKey ? getDeed(crisis.propertyKey).name : 'a property';
  return {
    kind: 'CRISIS',
    label: `Crisis bill (${name})`,
    creditorIds: [],
    owed: () => crisis.amount - crisis.paid,
    pay(amount) {
      d.transfer({ type: 'CRISIS_PAYMENT', from: player.id, to: null, amount, propertyKey: crisis.propertyKey, memo: `Crisis bill (${name})` });
      crisis.paid += amount;
    },
    close(unpaid) {
      crisis.status = unpaid === 0 ? 'PAID' : kind === 'BANKRUPTCY' ? 'BANKRUPT' : 'UNPAID';
      crisis.settledAt = d.ctx.now;
      d.event(
        unpaid === 0 ? 'CRISIS_SETTLED' : 'CRISIS_UNPAID',
        player.id,
        unpaid === 0 ? `${player.name} paid the ${formatINR(crisis.amount)} crisis bill for ${name}` : `${player.name} left ${formatINR(unpaid)} of the crisis bill for ${name} unpaid`,
        { crisisId: crisis.id, checkpoint: crisis.checkpoint, propertyKey: crisis.propertyKey, amount: crisis.amount, paid: crisis.paid },
      );
    },
  };
}

/**
 * `interestClaimed`: the interest charged on this loan is the payment the turn was waiting on, a claim of its
 * own that comes first — whatever of it that claim could not pay is recorded there, so it is not owed twice here.
 */
function classicLoanClaim(d: Draft, player: PlayerState, loan: LoanState, interestClaimed: boolean): Claim {
  const interestOwed = () => (interestClaimed ? 0 : loanInterestUnpaid(loan));
  return {
    kind: 'LOAN',
    label: 'Bank loan',
    creditorIds: [],
    // Interest charged at Start and still unpaid, then principal.
    owed: () => interestOwed() + loan.outstanding,
    pay(amount) {
      const interest = Math.min(amount, interestOwed());
      if (interest > 0) {
        d.transfer({ type: 'LOAN_INTEREST', from: player.id, to: null, amount: interest, memo: 'Loan interest (estate settlement)' });
        loan.interestPaid += interest;
      }
      const principal = amount - interest;
      if (principal > 0) {
        d.transfer({ type: 'LOAN_REPAYMENT', from: player.id, to: null, amount: principal, memo: 'Loan repayment (estate settlement)' });
        loan.outstanding -= principal;
      }
    },
    close(unpaid) {
      // Paid off: REPAID. Otherwise DEFAULTED and closed: `outstanding` (and any interest unpaid) records what the estate could not pay.
      loan.status = unpaid === 0 && loan.outstanding === 0 && loanInterestUnpaid(loan) === 0 ? 'REPAID' : 'DEFAULTED';
      loan.closedAt = d.ctx.now;
    },
  };
}

/** `covered`: what the loan's own collateral already paid (seizeCollateral) — off the interest first, then the principal. */
function capitalLoanClaim(d: Draft, player: PlayerState, loan: IntermediateLoan, covered: number): Claim {
  const eco = economyOf(d.state)!;
  const payoff = loanPayoff(eco, loan);
  let interest = Math.max(0, payoff.interest - covered);
  let principal = Math.max(0, payoff.principal - Math.max(0, covered - payoff.interest));
  const name = IR.loans.products[loan.product].name;
  return {
    kind: 'LOAN',
    label: name,
    creditorIds: [],
    owed: () => interest + principal,
    pay(amount) {
      const i = Math.min(amount, interest);
      if (i > 0) d.transfer({ type: 'LOAN_INTEREST', from: player.id, to: null, amount: i, memo: `${name} — interest (estate settlement)` });
      const p = amount - i;
      if (p > 0) d.transfer({ type: 'LOAN_REPAYMENT', from: player.id, to: null, amount: p, memo: `${name} — principal (estate settlement)` });
      interest -= i;
      principal -= p;
    },
    close(unpaid) {
      if (loan.status === 'DEFAULTED') loan.defaultBalance = unpaid;
      loan.status = unpaid === 0 ? 'SETTLED' : 'WRITTEN_OFF';
      if (unpaid > 0) loan.writtenOff = unpaid;
      loan.collateralKey = null;
      loan.closedAt = d.ctx.now;
    },
  };
}

/**
 * Capital secured loans still being repaid: the pledged property goes to the bank at today's market
 * value, set against that loan's payoff (the same recovery a default makes, recorded the same way);
 * a surplus is paid to the player, a shortfall stays on the loan as an ordinary claim. Once per loan:
 * the claim and the property move together and the loan holds no collateral afterwards.
 */
function seizeCollateral(d: Draft, player: PlayerState): Map<string, number> {
  const covered = new Map<string, number>();
  const eco = economyOf(d.state);
  if (!eco) return covered;
  for (const loan of loansOf(eco, player.id)) {
    const key = loan.collateralKey;
    if (loan.status !== 'ACTIVE' || !key || d.state.properties[key].ownerId !== player.id) continue;
    const payoff = loanPayoff(eco, loan);
    const value = eco.market[key].value;
    const { applied, surplus, remaining } = settleCollateral(value, payoff.principal + payoff.interest);
    loan.collateralKey = null;
    loan.settlement = { propertyKey: key, value, applied, surplus };
    covered.set(loan.id, applied);
    clearProperty(d, key);
    if (surplus > 0) d.transfer({ type: 'COLLATERAL_SURPLUS', from: null, to: player.id, amount: surplus, propertyKey: key, memo: `Collateral surplus (${getDeed(key).name})` });
    d.event(
      'COLLATERAL_SEIZED',
      player.id,
      `The bank took ${getDeed(key).name} (worth ${formatINR(value)}) for ${player.name}'s ${IR.loans.products[loan.product].name}` +
        (surplus > 0 ? ` and returned ${formatINR(surplus)}` : remaining > 0 ? ` — ${formatINR(remaining)} still owed` : ''),
      { loanId: loan.id, propertyKey: key, value, applied, surplus, remaining },
    );
  }
  return covered;
}

/**
 * Raises cash the way the player could have: buildings first (each sold back at building.sellBackRate
 * of its cost, exactly as SELL_BUILDING pays), then unmortgaged, unpledged property sold to the bank at
 * its mortgage value — board order, stopping as soon as `target` is covered. Returns what it raised.
 */
function liquidate(d: Draft, player: PlayerState, target: number): number {
  let raised = 0;
  const enough = () => player.balance >= target;
  for (const key of ownedBy(d.state, player.id)) {
    if (enough()) return raised;
    const prop = d.state.properties[key];
    if (prop.mortgaged) continue;
    while (!enough() && (prop.hotel || prop.houses > 0)) {
      const refund = sellBuildingRefund(key, prop);
      const wasHotel = prop.hotel;
      if (wasHotel) {
        prop.hotel = false;
        prop.houses = 0;
      } else {
        prop.houses -= 1;
      }
      if (refund > 0) {
        d.transfer({ type: wasHotel ? 'HOTEL_SALE' : 'HOUSE_SALE', from: null, to: player.id, amount: refund, propertyKey: key, memo: `Estate: sold ${wasHotel ? 'hotel' : 'house'} on ${getDeed(key).name}` });
        raised += refund;
      }
    }
  }
  for (const key of ownedBy(d.state, player.id)) {
    if (enough()) return raised;
    const prop = d.state.properties[key];
    if (prop.mortgaged || prop.hotel || prop.houses > 0) continue;
    const amount = getDeed(key).mortgageValue;
    d.transfer({ type: 'PROPERTY_SALE', from: null, to: player.id, amount, propertyKey: key, memo: `Estate: sold ${getDeed(key).name} to the bank` });
    clearProperty(d, key);
    raised += amount;
  }
  return raised;
}

function clearProperty(d: Draft, key: PropertyKey): void {
  const prop = d.state.properties[key];
  prop.ownerId = null;
  prop.houses = 0;
  prop.hotel = false;
  prop.mortgaged = false;
}

/** Everything still in the player's name goes back to the bank, clean. Returns the keys. */
function returnPropertiesToBank(d: Draft, playerId: string): PropertyKey[] {
  const returned = PROPERTY_KEYS.filter((k) => d.state.properties[k].ownerId === playerId);
  for (const key of returned) clearProperty(d, key);
  return returned;
}
