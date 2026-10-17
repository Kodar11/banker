import { describe, expect, it } from 'vitest';
import {
  annualStartIncome,
  balanceSheet,
  BOARD_SIZE,
  buildSchedule,
  creditScoreOf,
  crisisCheckpointClock,
  eligibleCollateral,
  gameClock,
  GameError,
  getDeed,
  INTERMEDIATE_RULES,
  isPledged,
  LOAN_PRODUCT_KEYS,
  loanCollateralKeys,
  loanOffers,
  loanPayoff,
  loanRequestBlocker,
  offeredRate,
  prepaymentQuote,
  propertyActionBlocker,
  refinanceBlocker,
  repaymentBudget,
  scheduledPrincipal,
  topUndoable,
  totalDebt,
  viewEvent,
  type IntermediateLoan,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';

/**
 * The complete Capital loan system: the agreed five products, interest on outstanding principal,
 * pooled collateral with buildings, repayment capacity, refinancing, collateral release and recovery,
 * and what the end of the game does to an open loan. The older suites (intermediateMode, economyRules)
 * cover the schedule, credit events, grace and default in depth; this one covers what they do not.
 */

const IR = INTERMEDIATE_RULES;
const START_CASH = 25000;
/** Two starting players: one financial year = 72 spaces on the shared clock. */
const YEAR = 72;
const WINDOW = 18;

const newGame = (loanLimit?: number) => new TestGame(['Asha', 'Bilal'], { mode: 'intermediate', ...(loanLimit ? { config: { loanLimit } } : {}) });
const eco = (g: TestGame): IntermediateState => g.state.intermediate!;
const scoreOf = (g: TestGame, name: string) => creditScoreOf(eco(g), g.id(name));
const loanOf = (g: TestGame, id: string): IntermediateLoan => eco(g).loans.find((l) => l.id === id)!;
const offerOf = (g: TestGame, name: string, product: LoanProductKey, replacingLoanId?: string) =>
  loanOffers(g.state, g.id(name), { replacingLoanId }).find((o) => o.product === product)!;

function tick(g: TestGame, total = 2) {
  const name = g.current;
  g.placeAt(name, (BOARD_SIZE - total) % BOARD_SIZE);
  const [a, b] = [Math.min(6, total - 1), total - Math.min(6, total - 1)];
  g.queueRandom(faceToRandom(a), faceToRandom(b));
  const result = g.act(name, { type: 'ROLL_DICE' });
  g.act(name, { type: 'END_TURN' });
  return result;
}

/** Puts the shared clock at `target` (test surgery on the stored movement, crises moved out of the way). */
function jumpTo(g: TestGame, target: number) {
  const movement = eco(g).movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = target - 2;
  const ins = eco(g).insurance!;
  while (crisisCheckpointClock(eco(g), ins.nextCheckpoint) <= target) ins.nextCheckpoint += 1;
  const result = tick(g, 2);
  expect(gameClock(eco(g))).toBe(target);
  return result;
}

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number, collateralKeys: PropertyKey[] = []): IntermediateLoan {
  const expectedRatePercent = offeredRate(product, scoreOf(g, name)).ratePercent;
  g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKeys.length ? { collateralKeys } : {}) });
  return eco(g).loans[eco(g).loans.length - 1]!;
}

function refinance(g: TestGame, name: string, loanId: string, product: LoanProductKey, amount: number, collateralKeys: PropertyKey[] = []) {
  const expectedRatePercent = offeredRate(product, scoreOf(g, name)).ratePercent;
  return g.act(name, { type: 'REFINANCE_INTERMEDIATE_LOAN', loanId, product, amount, expectedRatePercent, ...(collateralKeys.length ? { collateralKeys } : {}) });
}

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GameError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

const houseCost = (key: PropertyKey) => (getDeed(key) as { houseCost: number }).houseCost;
const hotelCost = (key: PropertyKey) => (getDeed(key) as { hotelCost: number }).hotelCost;

// ---------------------------------------------------------------------------

describe('the five products', () => {
  it('each product has its own purpose: rate, term, limits and security, all from the one configuration', () => {
    const g = newGame(50000);
    const offers = loanOffers(g.state, g.id('Asha'));
    expect(offers.map((o) => o.product)).toEqual([...LOAN_PRODUCT_KEYS]);
    for (const o of offers) {
      const p = IR.loans.products[o.product];
      expect(o).toMatchObject({ marketRatePercent: p.baseRatePercent, tenureYears: p.tenureYears, productLimit: p.maxPrincipal, secured: p.secured, rateType: p.rateType, minAmount: 10000 });
      // The adjustment is in points, never a proportion: 700 is the Good band, −1 point.
      expect(o.ratePercent).toBe(p.baseRatePercent - 1);
    }
    // Secured is the cheapest; Emergency the dearest; only Flexible is variable.
    const rate = (k: LoanProductKey) => offers.find((o) => o.product === k)!.ratePercent;
    expect(Math.min(...offers.map((o) => o.ratePercent))).toBe(rate('SECURED'));
    expect(Math.max(...offers.map((o) => o.ratePercent))).toBe(rate('EMERGENCY'));
    expect(offers.filter((o) => o.rateType === 'VARIABLE').map((o) => o.product)).toEqual(['FLEXIBLE']);
  });

  it('a player with no property can borrow on all four unsecured products — and the amount is theirs to choose', () => {
    const g = newGame(50000);
    expect(eligibleCollateral(g.state, g.id('Asha'))).toEqual([]);
    for (const product of ['EMERGENCY', 'PERSONAL', 'LONG_TERM', 'FLEXIBLE'] as const) {
      expect(offerOf(g, 'Asha', product).blocked).toBeNull();
      expect(loanRequestBlocker(g.state, g.id('Asha'), product, 10000, [])).toBeNull();
      expect(loanRequestBlocker(g.state, g.id('Asha'), product, 12500, [])).toBeNull();
    }
    expect(borrow(g, 'Asha', 'PERSONAL', 12500).principal).toBe(12500);
  });

  it('no single loan passes ₹50,000, whatever the host limit and the collateral', () => {
    const g = newGame(50000);
    g.give('Asha', 'RAILWAY');
    g.give('Asha', 'AIR_INDIA');
    eco(g).market.RAILWAY.value = 40000;
    eco(g).market.AIR_INDIA.value = 40000;
    const offer = offerOf(g, 'Asha', 'SECURED');
    expect(offer.collateralValue).toBeGreaterThan(62500);
    expect(offer.maxAmount).toBe(50000);
    const all = offer.collateral.map((c) => c.key);
    expect(loanRequestBlocker(g.state, g.id('Asha'), 'SECURED', 50500, all)).toBe('Secured Loans go up to ₹50,000.');
    expect(borrow(g, 'Asha', 'SECURED', 50000, all).principal).toBe(50000);
  });
});

describe('interest on the outstanding principal', () => {
  it('each year’s interest is charged on what is still owed, so it falls; principal parts add up exactly; the ledger matches the schedule', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'PERSONAL', 20000);
    const lines = loan.installments;
    let owed = 20000;
    for (const line of lines) {
      expect(line.interest).toBe(Math.floor((owed * loan.ratePercent * 2 + 100) / 200)); // half up, on the balance
      owed -= line.principal;
    }
    expect(owed).toBe(0);
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]!.interest).toBeLessThan(lines[i - 1]!.interest);
    for (let k = 1; k <= loan.tenureYears; k += 1) {
      jumpTo(g, YEAR * k);
      g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    }
    const paid = g.ledger.filter((t) => t.fromPlayerId === g.id('Asha') && (t.type === 'LOAN_REPAYMENT' || t.type === 'LOAN_INTEREST'));
    expect(paid.filter((t) => t.type === 'LOAN_REPAYMENT').reduce((s, t) => s + t.amount, 0)).toBe(20000);
    expect(paid.filter((t) => t.type === 'LOAN_INTEREST').reduce((s, t) => s + t.amount, 0)).toBe(lines.reduce((s, l) => s + l.interest, 0));
    expect(loanOf(g, loan.id).status).toBe('REPAID');
  });
});

// ---------------------------------------------------------------------------

describe('pooled collateral', () => {
  it('the agreed example: ₹50,000 of property and ₹12,500 of buildings secure up to ₹50,000', () => {
    const g = newGame(50000);
    g.give('Asha', 'MUMBAI', { houses: 2 });
    g.give('Asha', 'DELHI', { houses: 2 });
    eco(g).market.MUMBAI.value = 30000;
    eco(g).market.DELHI.value = 20000;
    const buildings = Math.floor((2 * houseCost('MUMBAI') + 2 * houseCost('DELHI')) / 2);
    expect(buildings).toBe(12500);
    const offer = offerOf(g, 'Asha', 'SECURED');
    expect(offer).toMatchObject({ collateralValue: 62500, collateralLimit: 50000, maxAmount: 50000, blocked: null });
    const loan = borrow(g, 'Asha', 'SECURED', 50000, ['MUMBAI', 'DELHI']);
    expect(loan.pledges).toEqual([
      { key: 'MUMBAI', propertyValue: 30000, buildingValue: houseCost('MUMBAI'), houses: 2, hotel: false },
      { key: 'DELHI', propertyValue: 20000, buildingValue: houseCost('DELHI'), houses: 2, hotel: false },
    ]);
  });

  it('a hotel counts at half of everything built for it; one property alone can secure a loan', () => {
    const g = newGame(50000);
    g.give('Asha', 'MUMBAI', { hotel: true });
    const [option] = eligibleCollateral(g.state, g.id('Asha'));
    const built = hotelCost('MUMBAI') + 3 * houseCost('MUMBAI');
    expect(option).toEqual({ key: 'MUMBAI', marketValue: 8500, buildingValue: Math.floor(built / 2), houses: 0, hotel: true, value: 8500 + Math.floor(built / 2) });
    const limit = Math.floor((option!.value * 0.8) / 500) * 500;
    expect(offerOf(g, 'Asha', 'SECURED').maxAmount).toBe(Math.min(limit, 50000));
    expect(borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI']).collateralKeys).toEqual(['MUMBAI']);
  });

  it('too little collateral refuses the secured loan, with the reason — unsecured offers stay open', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    const offer = offerOf(g, 'Asha', 'SECURED');
    expect(offer.blocked).toBe('Everything you could pledge is worth ₹8,500: 80% of it is ₹6,500, below the ₹10,000 minimum.');
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI'])).code).toBe('LOAN_NOT_ALLOWED');
    expect(offerOf(g, 'Asha', 'PERSONAL').blocked).toBeNull();
  });

  it('pledged buildings are locked in: they can’t be sold back, and nothing pledged can be mortgaged, sold, traded or auctioned', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    g.give('Asha', 'DELHI');
    borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'DELHI']);
    expect(refusal(() => g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' })).message).toMatch(/Pledged as loan collateral with its buildings/);
    expect(propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'SELL_BUILDING')).toMatch(/repay that loan first/);
    expect(g.state.properties.MUMBAI.houses).toBe(2);
    for (const key of ['MUMBAI', 'DELHI'] as const) {
      expect(isPledged(g.state, key)).toBe(true);
      for (const type of ['MORTGAGE_PROPERTY', 'SELL_PROPERTY', 'BUILD_HOUSE'] as const) expect(propertyActionBlocker(g.state, g.id('Asha'), key, type)).toMatch(/Pledged/);
      expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: key, reservePrice: 5000 })).message).toMatch(/Pledged as loan collateral/);
    }
  });

  it('a property can’t back two live loans, even split across requests', () => {
    const g = newGame(50000);
    for (const key of ['MUMBAI', 'DELHI', 'MADRAS'] as const) g.give('Asha', key);
    borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'DELHI']);
    expect(eligibleCollateral(g.state, g.id('Asha')).map((c) => c.key)).toEqual(['MADRAS']);
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'MADRAS'])).code).toBe('LOAN_NOT_ALLOWED');
    const keys = eco(g).loans.flatMap((l) => loanCollateralKeys(l));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('repaying in full releases every pledged property once; a repeated repayment changes nothing', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI');
    const loan = borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'DELHI']);
    jumpTo(g, 30);
    const quote = prepaymentQuote(eco(g), loanOf(g, loan.id), 10000);
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: 10000 });
    expect(g.balance('Asha')).toBe(cash - quote.total);
    expect(r.events.filter((e) => e.type === 'INTERMEDIATE_LOAN_REPAID').map((e) => e.payload.releasedCollateralKeys)).toEqual([['MUMBAI', 'DELHI']]);
    expect(isPledged(g.state, 'MUMBAI') || isPledged(g.state, 'DELHI')).toBe(false);
    const after = g.balance('Asha');
    expect(refusal(() => g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: 10000 })).code).toBe('LOAN_NOT_ALLOWED');
    expect(g.balance('Asha')).toBe(after);
    // Prepaid before anything fell due: no score for it.
    expect(eco(g).creditEvents).toEqual([]);
  });

  it('default takes only what was pledged — buildings at half their cost — returns the surplus once, and leaves everything else alone', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { houses: 1 });
    g.give('Asha', 'DELHI');
    g.give('Asha', 'AGRA', { houses: 1 }); // not pledged
    const loan = borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'DELHI']);
    jumpTo(g, YEAR + WINDOW + YEAR - 1);
    const cash = g.balance('Asha');
    const r = tick(g, 2);
    const settled = loanOf(g, loan.id);
    const value = eco(g).market.MUMBAI.value + Math.floor(houseCost('MUMBAI') / 2) + eco(g).market.DELHI.value;
    expect(settled.settlement).toMatchObject({ propertyKeys: ['MUMBAI', 'DELHI'], value });
    const surplus = settled.settlement!.surplus;
    expect(surplus).toBeGreaterThan(0);
    expect(r.transactions.filter((t) => t.type === 'COLLATERAL_SURPLUS').map((t) => t.amount)).toEqual([surplus]);
    expect(g.balance('Asha')).toBe(cash + surplus + r.transactions.filter((t) => t.type === 'START_REWARD' && t.toPlayerId === g.id('Asha')).reduce((s, t) => s + t.amount, 0));
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: null, houses: 0 });
    expect(g.state.properties.AGRA).toMatchObject({ ownerId: g.id('Asha'), houses: 1 });
    expect(settled.pledges!.map((p) => p.key)).toEqual(['MUMBAI', 'DELHI']); // the record of what was pledged stays
    jumpTo(g, YEAR * 4);
    expect(g.ledger.filter((t) => t.type === 'COLLATERAL_SURPLUS')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('repayment capacity', () => {
  it('is net worth plus a year of Start rewards, and borrowing does not move it', () => {
    const g = newGame();
    expect(annualStartIncome()).toBe(1500);
    expect(repaymentBudget(g.state, g.id('Asha'))).toBe(START_CASH + 1500);
    borrow(g, 'Asha', 'PERSONAL', 10000);
    expect(repaymentBudget(g.state, g.id('Asha'))).toBe(START_CASH + 1500);
  });

  it('refuses a loan whose first year of payments, with every other loan’s, is more than that — and offers the most that fits', () => {
    const g = newGame(50000);
    // Asha gives most of her money away: ₹4,000 left, no property — a net worth of ₹4,000.
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START_CASH - 4000 });
    const budget = 4000 + 1500;
    // Emergency: ₹10,000 at 17% is ₹11,700 in one payment — more than she could ever cover.
    const emergency = offerOf(g, 'Asha', 'EMERGENCY');
    expect(emergency.blocked).toMatch(/Repayment limit/);
    expect(emergency.maxAmount).toBe(0);
    // Long-term: ₹10,000 over five years is about ₹2,638 a year — that fits, up to the most whose payment fits.
    const longTerm = offerOf(g, 'Asha', 'LONG_TERM');
    expect(longTerm.blocked).toBeNull();
    const first = (amount: number) => buildSchedule(amount, longTerm.ratePercent, 5)[0]!;
    const pay = (amount: number) => first(amount).principal + first(amount).interest;
    expect(pay(longTerm.maxAmount)).toBeLessThanOrEqual(budget);
    expect(pay(longTerm.maxAmount + 500)).toBeGreaterThan(budget);
    borrow(g, 'Asha', 'LONG_TERM', 10000);
    // The new loan's payment now counts against every later request.
    expect(offerOf(g, 'Asha', 'LONG_TERM').paymentBudget).toBe(budget - pay(10000));
    expect(refusal(() => borrow(g, 'Asha', 'PERSONAL', 10000)).message).toMatch(/Repayment limit/);
  });

  it('multiple loans are fine within the total limit and capacity, each with its own contract', () => {
    const g = newGame(50000);
    const a = borrow(g, 'Asha', 'PERSONAL', 10000);
    const b = borrow(g, 'Asha', 'FLEXIBLE', 15000);
    const c = borrow(g, 'Asha', 'EMERGENCY', 10000);
    expect([a, b, c].map((l) => [l.product, l.ratePercent, l.tenureYears, l.rateType])).toEqual([
      ['PERSONAL', 12, 3, 'FIXED'],
      ['FLEXIBLE', 11, 3, 'VARIABLE'],
      ['EMERGENCY', 17, 1, 'FIXED'],
    ]);
    jumpTo(g, YEAR);
    // Each payment is booked against its own loan.
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: b.id });
    expect(loanOf(g, b.id).installments[0]!.status).toBe('PAID');
    expect(loanOf(g, a.id).installments[0]!.status).toBe('DUE');
    expect(loanOf(g, c.id).installments[0]!.status).toBe('DUE');
    expect(eco(g).creditEvents.map((e) => [e.type, e.loanId])).toEqual([['ON_TIME_PAYMENT', b.id]]);
  });
});

// ---------------------------------------------------------------------------

describe('refinancing', () => {
  it('pays off the old loan with the new one in one step: history kept, nothing reset, net worth unchanged', () => {
    const g = newGame();
    const old = borrow(g, 'Asha', 'PERSONAL', 15000);
    jumpTo(g, 36);
    const payoff = prepaymentQuote(eco(g), loanOf(g, old.id), 15000);
    expect(payoff.accruedInterest).toBe(900); // half a year at 12% on 15,000
    const worth = balanceSheet(g.state, g.id('Asha')).netWorth;
    const cash = g.balance('Asha');
    // A brand-new ₹20,000 loan would pass the ₹20,000 limit; replacing this one frees its principal.
    expect(offerOf(g, 'Asha', 'LONG_TERM').blocked).toMatch(/borrowing limit/);
    expect(offerOf(g, 'Asha', 'LONG_TERM', old.id).maxAmount).toBe(20000);
    const r = refinance(g, 'Asha', old.id, 'LONG_TERM', 20000);
    const replacement = eco(g).loans[eco(g).loans.length - 1]!;
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['LOAN_DISBURSEMENT', 20000],
      ['LOAN_REPAYMENT', 15000],
      ['LOAN_INTEREST', 900],
    ]);
    expect(g.balance('Asha')).toBe(cash + 20000 - 15900);
    expect(loanOf(g, old.id)).toMatchObject({ status: 'SETTLED', refinancedInto: replacement.id, installments: [], prepayments: [{ clock: 36, year: 1, principal: 15000, interest: 900 }] });
    expect(replacement).toMatchObject({ product: 'LONG_TERM', principal: 20000, status: 'ACTIVE', refinancedFrom: old.id, originClock: 36 });
    expect(totalDebt(g.state, g.id('Asha'))).toBe(20000);
    expect(balanceSheet(g.state, g.id('Asha')).netWorth).toBe(worth);
    expect(r.events.filter((e) => e.type === 'LOAN_REFINANCED')).toHaveLength(1);
    expect(eco(g).creditEvents).toEqual([]);
  });

  it('a smaller replacement: the difference comes from cash, and the player must have it', () => {
    const g = newGame();
    const old = borrow(g, 'Asha', 'EMERGENCY', 15000);
    jumpTo(g, 36);
    const payoff = prepaymentQuote(eco(g), loanOf(g, old.id), 15000).total;
    const cash = g.balance('Asha');
    refinance(g, 'Asha', old.id, 'PERSONAL', 10000);
    expect(g.balance('Asha')).toBe(cash + 10000 - payoff);

    // Worth enough to carry the new loan, but short of the cash to close the gap.
    const h = newGame();
    h.give('Asha', 'RAILWAY');
    h.give('Asha', 'AIR_INDIA');
    const loan = borrow(h, 'Asha', 'EMERGENCY', 15000);
    h.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: h.id('Bilal'), amount: h.balance('Asha') - 1000 });
    expect(offerOf(h, 'Asha', 'PERSONAL', loan.id).blocked).toBeNull();
    const before = JSON.stringify(h.state.intermediate);
    expect(refusal(() => refinance(h, 'Asha', loan.id, 'PERSONAL', 10000)).code).toBe('INSUFFICIENT_FUNDS');
    expect(JSON.stringify(h.state.intermediate)).toBe(before);
  });

  it('earns no repayment bonus, even after on-time payments, and never clears a missed payment', () => {
    const g = newGame();
    const old = borrow(g, 'Asha', 'PERSONAL', 10000);
    jumpTo(g, YEAR);
    // Due and unpaid: pay it first.
    expect(refinanceBlocker(eco(g), g.id('Asha'), old.id)).toBe('Pay the installment that is due first.');
    expect(refusal(() => refinance(g, 'Asha', old.id, 'LONG_TERM', 10000)).message).toBe('Pay the installment that is due first.');
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: old.id });
    expect(scoreOf(g, 'Asha')).toBe(705);
    refinance(g, 'Asha', old.id, 'LONG_TERM', 10000);
    expect(loanOf(g, old.id).status).toBe('SETTLED');
    expect(eco(g).creditEvents.map((e) => e.type)).toEqual(['ON_TIME_PAYMENT']);

    // Overdue (on another loan) or in default: no refinancing.
    const h = newGame(50000);
    const late = borrow(h, 'Asha', 'EMERGENCY', 10000);
    const other = borrow(h, 'Asha', 'LONG_TERM', 10000);
    jumpTo(h, YEAR + WINDOW);
    expect(loanOf(h, late.id).installments[0]!.status).toBe('OVERDUE');
    h.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: other.id }); // the other loan's own payment is fine
    expect(refusal(() => refinance(h, 'Asha', other.id, 'PERSONAL', 10000)).message).toMatch(/overdue payment/);
    jumpTo(h, YEAR + WINDOW + YEAR);
    expect(loanOf(h, late.id).status).toBe('DEFAULTED');
    expect(refusal(() => refinance(h, 'Asha', late.id, 'PERSONAL', 10000)).message).toMatch(/Only a loan being repaid on its schedule/);
    h.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: other.id }); // its second installment, so only the default stands in the way
    expect(refusal(() => refinance(h, 'Asha', other.id, 'PERSONAL', 10000)).message).toMatch(/in default/);
  });

  it('moves collateral from the old loan to the new one in the same step — never backing two loans', () => {
    const g = newGame(50000);
    for (const key of ['MUMBAI', 'DELHI', 'MADRAS'] as const) g.give('Asha', key);
    const old = borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'DELHI']);
    // Its own collateral is free for the replacement; with Madras the pool is larger.
    expect(offerOf(g, 'Asha', 'SECURED', old.id).collateral.map((c) => c.key)).toEqual(['MUMBAI', 'MADRAS', 'DELHI']);
    refinance(g, 'Asha', old.id, 'SECURED', 15000, ['MUMBAI', 'DELHI', 'MADRAS']);
    const replacement = eco(g).loans[1]!;
    expect(loanCollateralKeys(loanOf(g, old.id))).toEqual([]);
    expect(loanCollateralKeys(replacement)).toEqual(['MUMBAI', 'DELHI', 'MADRAS']);
    const live = eco(g).loans.filter((l) => l.status === 'ACTIVE').flatMap((l) => loanCollateralKeys(l));
    expect(new Set(live).size).toBe(live.length);
    // Into an unsecured loan: the pledge simply ends.
    refinance(g, 'Asha', replacement.id, 'PERSONAL', 15000);
    expect(['MUMBAI', 'DELHI', 'MADRAS'].some((k) => isPledged(g.state, k as PropertyKey))).toBe(false);
  });

  it('a retried or stale request changes nothing twice', () => {
    const g = newGame();
    const old = borrow(g, 'Asha', 'PERSONAL', 10000);
    jumpTo(g, 20);
    // The offer changed under the player: refused, nothing moves.
    const before = JSON.stringify(g.state.intermediate);
    expect(refusal(() => g.act('Asha', { type: 'REFINANCE_INTERMEDIATE_LOAN', loanId: old.id, product: 'LONG_TERM', amount: 10000, expectedRatePercent: 3 })).code).toBe('STALE_STATE');
    expect(JSON.stringify(g.state.intermediate)).toBe(before);
    refinance(g, 'Asha', old.id, 'LONG_TERM', 10000);
    const cash = g.balance('Asha');
    const loans = eco(g).loans.length;
    expect(refusal(() => refinance(g, 'Asha', old.id, 'LONG_TERM', 10000)).code).toBe('LOAN_NOT_ALLOWED');
    expect(g.balance('Asha')).toBe(cash);
    expect(eco(g).loans).toHaveLength(loans);
    // Nobody else can refinance it.
    expect(refusal(() => refinance(g, 'Bilal', eco(g).loans[1]!.id, 'PERSONAL', 10000)).code).toBe('NOT_FOUND');
  });

  it('is private under hidden finances', () => {
    const g = newGame();
    const old = borrow(g, 'Asha', 'PERSONAL', 10000);
    const r = refinance(g, 'Asha', old.id, 'LONG_TERM', 10000);
    const event = r.events.find((e) => e.type === 'LOAN_REFINANCED')!;
    expect(viewEvent(event, g.id('Bilal'), () => 'x')).toBeNull();
    expect(viewEvent(event, g.id('Asha'), () => 'x')).toEqual(event);
  });
});

// ---------------------------------------------------------------------------

describe('undo and the end of the game', () => {
  it('a loan is never an undo entry: an undo can’t take back the debt and leave the cash', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    const built = topUndoable(g.state)!;
    borrow(g, 'Asha', 'PERSONAL', 10000);
    expect(topUndoable(g.state)).toEqual(built);
    expect(g.state.undoStack.some((u) => u.actionType === ('TAKE_INTERMEDIATE_LOAN' as never))).toBe(false);
  });

  it('the game ending collects nothing and seizes nothing: an open secured loan counts at its payoff, its collateral stays the borrower’s', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI');
    const loan = borrow(g, 'Asha', 'SECURED', 10000, ['MUMBAI', 'DELHI']);
    jumpTo(g, 30);
    const payoff = loanPayoff(eco(g), loanOf(g, loan.id));
    // Only the interest built up so far — never the interest of the years still to come.
    expect(payoff).toEqual({ principal: 10000, interest: Math.floor((10000 * loan.ratePercent * 30 * 2 + 100 * YEAR) / (200 * YEAR)) });
    expect(payoff.interest).toBeLessThan(buildSchedule(10000, loan.ratePercent, 3)[0]!.interest);
    const sheet = balanceSheet(g.state, g.id('Asha'));
    expect(sheet.loans).toBe(payoff.principal + payoff.interest);
    const r = g.endByVote('Asha');
    expect(g.state.status).toBe('FINISHED');
    expect(r.events.some((e) => e.type === 'COLLATERAL_SEIZED')).toBe(false);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    expect(loanOf(g, loan.id).status).toBe('ACTIVE');
    expect(scheduledPrincipal(loanOf(g, loan.id))).toBe(10000);
  });
});
