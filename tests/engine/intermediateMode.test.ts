import { describe, expect, it } from 'vitest';
import {
  accruedInterest,
  applyAction,
  applyCardDefinition,
  applyMarketChange,
  BOARD_SIZE,
  borrowingBlock,
  buildSchedule,
  clockLabel,
  creditScoreOf,
  eligibleCollateral,
  financialOverview,
  gameClock,
  GameError,
  getDeed,
  INTERMEDIATE_RULES,
  installmentDeadlines,
  loanOffers,
  netWorth,
  offeredRate,
  paymentsOwedNow,
  positionOfSpecial,
  prepaymentQuote,
  PROPERTY_KEYS,
  propertyActionBlocker,
  propertyValuation,
  totalDebt,
  unmortgageCost,
  yearLength,
  type CardDefinition,
  type IntermediateLoan,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';

const IR = INTERMEDIATE_RULES;
const START_CASH = 25000;
const REWARD = 1500;
/** Two starting players: one financial year = 72 spaces on the shared clock. */
const YEAR = 72;
const WINDOW = 18;

const newGame = (names = ['Asha', 'Bilal']) => new TestGame(names, { mode: 'intermediate' });
const eco = (g: TestGame): IntermediateState => g.state.intermediate!;
const scoreOf = (g: TestGame, name: string) => creditScoreOf(eco(g), g.id(name));
const loanOf = (g: TestGame, id: string): IntermediateLoan => eco(g).loans.find((l) => l.id === id)!;

/** The current player rolls `total`, lands exactly on Start (nothing to resolve) and ends the turn. */
function tick(g: TestGame, total = 2, randoms: number[] = []) {
  const name = g.current;
  g.placeAt(name, (BOARD_SIZE - total) % BOARD_SIZE);
  const [a, b] = [Math.min(6, total - 1), total - Math.min(6, total - 1)];
  // Raw RNG values are consumed in order: the two dice, then whatever the economy draws.
  g.queueRandom(faceToRandom(a), faceToRandom(b), ...randoms);
  const result = g.act(name, { type: 'ROLL_DICE' });
  g.act(name, { type: 'END_TURN' });
  return result;
}

/** Puts the shared clock at `target` by one roll of 2 from just before it (test surgery on the stored movement). */
function jumpTo(g: TestGame, target: number, randoms: number[] = []) {
  const movement = eco(g).movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = target - 2;
  const result = tick(g, 2, randoms);
  expect(gameClock(eco(g))).toBe(target);
  return result;
}

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number, collateralKey?: PropertyKey): IntermediateLoan {
  const expectedRatePercent = offeredRate(product, scoreOf(g, name)).ratePercent;
  g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKey ? { collateralKey } : {}) });
  return eco(g).loans[eco(g).loans.length - 1]!;
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

const eventsOf = (r: { events: { type: string }[] }, type: string) => r.events.filter((e) => e.type === type);
const startRewards = (r: { transactions: { type: string; toPlayerId: string | null; amount: number }[] }, playerId: string) =>
  r.transactions.filter((t) => t.type === 'START_REWARD' && t.toPlayerId === playerId).reduce((sum, t) => sum + t.amount, 0);

// ---------------------------------------------------------------------------

describe('game mode', () => {
  it('a game is Classic unless the host chose Intermediate, and carries no economy', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    expect(g.state.mode).toBe('classic');
    expect(g.state.intermediate).toBeNull();
  });

  it('an Intermediate game gets its economy when it starts, not before', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { mode: 'intermediate', start: false });
    expect(g.state.mode).toBe('intermediate');
    expect(g.state.intermediate).toBeNull();
    g.startWith(['Asha', 'Bilal', 'Chitra']);
    const e = eco(g);
    expect(e).toMatchObject({ configVersion: IR.version, year: 1, playerCount: 3, loans: [], creditEvents: [], lastReport: null });
    expect(Object.keys(e.movement).sort()).toEqual([g.id('Asha'), g.id('Bilal'), g.id('Chitra')].sort());
    expect(Object.values(e.movement)).toEqual([0, 0, 0]);
    expect(Object.values(e.credit)).toEqual([700, 700, 700]);
    for (const key of PROPERTY_KEYS) {
      expect(e.market[key].value).toBe(getDeed(key).price);
      expect(e.market[key].lastChangePercent).toBeNull();
      expect(IR.market.trendOptions).toContain(e.market[key].trendPercent);
    }
  });

  it('players joining inherit the host mode — joining takes no mode of its own', () => {
    const g = new TestGame(['Asha'], { mode: 'intermediate', start: false });
    g.join('Bilal');
    expect(g.state.mode).toBe('intermediate');
    expect(g.state.players).toHaveLength(2);
  });

  it('the mode never changes: no action can set it', () => {
    const g = newGame();
    for (const action of [{ type: 'SET_MODE', mode: 'classic' }, { type: 'START_GAME', mode: 'classic' }, { type: 'END_TURN', mode: 'classic' }]) {
      expect(refusal(() => g.act('Asha', action as never)).code).toBe('VALIDATION');
    }
    tick(g);
    expect(g.state.mode).toBe('intermediate');
  });

  it('Classic games refuse every Intermediate banking action', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    const id = '00000000-0000-4000-8000-00000000abcd';
    expect(refusal(() => g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 5000, expectedRatePercent: 11 }))).toMatchObject({ code: 'LOAN_NOT_ALLOWED' });
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).code).toBe('LOAN_NOT_ALLOWED');
    expect(refusal(() => g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: id, amount: 1000 })).code).toBe('LOAN_NOT_ALLOWED');
    expect(refusal(() => g.act('Asha', { type: 'PAY_DEFAULTED_LOAN', loanId: id, amount: 1000 })).code).toBe('LOAN_NOT_ALLOWED');
    expect(g.state.intermediate).toBeNull();
    expect(g.balance('Asha')).toBe(START_CASH);
  });

  it('Intermediate games do not hand out the Classic flat-interest loan', () => {
    const g = newGame();
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 })).code).toBe('LOAN_NOT_ALLOWED');
    expect(g.state.loans).toEqual([]);
  });
});

describe('Classic Mode is untouched by the Intermediate rules', () => {
  it('draws exactly the randomness it always did (turn order, then two dice a roll)', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { start: false });
    let calls = 0;
    const counting = () => {
      const ctx = g.ctx();
      return { ...ctx, random: () => ((calls += 1), 0.999) };
    };
    const started = applyCardlessAction(g, 'Asha', { type: 'START_GAME' }, counting());
    expect(calls).toBe(2); // Fisher–Yates over three players
    expect(started.state.intermediate).toBeNull();
    calls = 0;
    g.absorbResult(started);
    const first = g.current;
    g.placeAt(first, 0);
    const rolled = applyCardlessAction(g, first, { type: 'ROLL_DICE' }, counting());
    expect(calls).toBe(2);
    expect(rolled.state.intermediate).toBeNull();
  });

  it('buys at the deed price, values net worth at deed prices, and never moves a financial year', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    expect(g.state.turn.pending).toEqual({ kind: 'BUY', propertyKey: 'MUMBAI', price: 8500 });
    const bought = g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(bought.transactions.map((t) => [t.type, t.amount])).toEqual([['PROPERTY_PURCHASE', 8500]]);
    // The move passed Start (+₹1,500); the purchase swaps ₹8,500 of cash for ₹8,500 of property.
    expect(netWorth(g.state, g.id('Asha'))).toBe(START_CASH + REWARD);
    g.act('Asha', { type: 'END_TURN' });
    for (let i = 0; i < 30; i += 1) tick(g, 12);
    expect(g.state.intermediate).toBeNull();
    expect(g.results.flatMap((r) => r.events).some((e) => e.type === 'FINANCIAL_YEAR_STARTED' || e.type === 'CREDIT_SCORE_CHANGED')).toBe(false);
  });

  it('keeps the Classic loan exactly as it was: full amount now, 10% once at the next Start', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    expect(g.state.loans[0]).toMatchObject({ principal: 5000, interestRatePercent: 10, interestAmount: 500, outstanding: 5000, status: 'ACTIVE' });
    expect(totalDebt(g.state, g.id('Asha'))).toBe(5000);
    const r = tick(g, 2);
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['START_REWARD', REWARD],
      ['LOAN_INTEREST', 500],
    ]);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 })).code).toBe('LOAN_NOT_ALLOWED');
  });

  it('keeps Classic mortgage, unmortgage and sell-to-bank values', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Asha', 'MUMBAI');
    expect(g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'MORTGAGE', amount: 4250 });
    expect(g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'UNMORTGAGE', amount: 4675 });
    expect(g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'PROPERTY_SALE', amount: 4250 });
  });
});

/** applyAction with a caller-supplied context (to observe the RNG). */
function applyCardlessAction(g: TestGame, name: string, action: Parameters<TestGame['act']>[1], ctx: ReturnType<TestGame['ctx']>) {
  return applyAction(g.state, g.id(name), action, ctx);
}

// ---------------------------------------------------------------------------

describe('shared financial years', () => {
  it('counts the spaces the dice moved a player, per player, cumulatively', () => {
    const g = newGame();
    tick(g, 7);
    tick(g, 12);
    tick(g, 3);
    expect(eco(g).movement).toEqual({ [g.id('Asha')]: 10, [g.id('Bilal')]: 12 });
    expect(gameClock(eco(g))).toBe(22);
    expect(eco(g).year).toBe(1);
  });

  it('card movement and Jail placement add nothing to the calendar', () => {
    const g = newGame();
    const card: CardDefinition = { id: 'TEST', deck: 'CHANCE', table: 'ODD', rollTotal: 9, text: 'test', verified: true, effects: [{ type: 'MOVE_STEPS', steps: 5, resolveLanding: false }] };
    g.absorbResult(applyCardDefinition(g.state, card, 9, g.ctx()));
    expect(gameClock(eco(g))).toBe(0);
    // Asha rolls 4 onto Jail: the 4 dice spaces count, being placed in Jail does not.
    g.act('Asha', { type: 'END_TURN' });
    tick(g, 2);
    g.landOn('Asha', positionOfSpecial('JAIL'), 4);
    expect(g.player('Asha').inJail).toBe(true);
    expect(eco(g).movement[g.id('Asha')]).toBe(4);
    // Actions that are not dice movement never move the clock.
    g.act('Asha', { type: 'END_TURN' });
    tick(g, 2);
    g.act('Asha', { type: 'STAY_IN_JAIL' });
    expect(gameClock(eco(g))).toBe(4 + 2 + 2);
  });

  it('advances when the average movement reaches 36 — once, in one action, for everyone', () => {
    const g = newGame();
    Object.assign(eco(g).movement, { [g.id('Asha')]: 35, [g.id('Bilal')]: 35 });
    const r = tick(g, 2);
    expect(eco(g).year).toBe(2);
    expect(eventsOf(r, 'FINANCIAL_YEAR_STARTED')).toHaveLength(1);
    expect(eco(g).lastReport?.year).toBe(2);
    // The next roll is still Year 2: nothing is applied again.
    const next = tick(g, 12);
    expect(eco(g).year).toBe(2);
    expect(eventsOf(next, 'FINANCIAL_YEAR_STARTED')).toHaveLength(0);
  });

  it('does not advance one space early', () => {
    const g = newGame();
    Object.assign(eco(g).movement, { [g.id('Asha')]: 34, [g.id('Bilal')]: 35 });
    tick(g, 2);
    expect(gameClock(eco(g))).toBe(71);
    expect(eco(g).year).toBe(1);
  });

  it('catches up year by year if one action crosses several thresholds', () => {
    const g = newGame();
    const r = jumpTo(g, YEAR * 3 + 5);
    expect(eco(g).year).toBe(4);
    expect(eventsOf(r, 'FINANCIAL_YEAR_STARTED').map((e) => (e as unknown as { payload: { year: number } }).payload.year)).toEqual([2, 3, 4]);
    // Three compounding +10% years (the harness RNG's default draw).
    expect(eco(g).market.MUMBAI.value).toBe(applyMarketChange(applyMarketChange(applyMarketChange(8500, 10), 10), 10));
  });

  it('keeps the starting player count as the denominator after a player leaves', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    expect(yearLength(eco(g))).toBe(108);
    g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(eco(g).playerCount).toBe(3);
    Object.assign(eco(g).movement, { [g.id('Asha')]: 40, [g.id('Bilal')]: 40, [g.id('Chitra')]: 20 });
    tick(g, 6);
    expect(eco(g).year).toBe(1); // 106 < 108: the departed player's 20 still counts, and the bar did not drop
    tick(g, 2);
    expect(eco(g).year).toBe(2);
  });

  it('keeps a bankrupt player in the denominator too', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Bilal', 'MUMBAI', { hotel: true });
    g.player('Asha').balance = 100;
    g.ledger.push({ id: 'x', actionId: 'x', type: 'PLAYER_TRANSFER', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: START_CASH - 100, propertyKey: null, memo: 'setup', reversesTransactionId: null, createdAt: '' });
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.player('Asha').status).toBe('BANKRUPT');
    expect(eco(g).playerCount).toBe(3);
    expect(eco(g).movement[g.id('Asha')]).toBe(5);
    expect(yearLength(eco(g))).toBe(108);
  });
});

describe('property market', () => {
  it('applies one stored change per property each year, to the previous value', () => {
    const g = newGame();
    // Dice, then 26 draws in property order: Mumbai −20%, Ahmedabad −10%, Calcutta 0%, Hyderabad +10%, Darjeeling +20%, the rest +10%.
    const draws = [0.05, 0.15, 0.4, 0.6, 0.9, ...Array(PROPERTY_KEYS.length - 5).fill(0.5)];
    const r = jumpTo(g, YEAR, draws);
    const m = eco(g).market;
    expect([m.MUMBAI.value, m.AHMEDABAD.value, m.CALCUTTA.value, m.HYDERABAD.value, m.DARJEELING.value]).toEqual([6800, 3600, 6500, 3900, 3000]);
    expect([m.MUMBAI.lastChangePercent, m.AHMEDABAD.lastChangePercent, m.CALCUTTA.lastChangePercent]).toEqual([-20, -10, 0]);
    expect(eco(g).lastReport?.changes.MUMBAI).toEqual({ percent: -20, from: 8500, to: 6800 });
    const event = eventsOf(r, 'FINANCIAL_YEAR_STARTED')[0] as unknown as { payload: { year: number; inflationPercent: number; changes: Record<string, unknown> } };
    expect(event.payload).toMatchObject({ year: 2, inflationPercent: 5 });
    expect(Object.keys(event.payload.changes)).toHaveLength(PROPERTY_KEYS.length);
    // Year 3 builds on Year 2's value, not on the original price.
    jumpTo(g, YEAR * 2, [0.6, ...Array(PROPERTY_KEYS.length - 1).fill(0.4)]);
    expect(eco(g).market.MUMBAI.value).toBe(7500); // 6,800 + 10% = 7,480 → 7,500
    expect(getDeed('MUMBAI').price).toBe(8500);
  });

  it('never rerolls: actions that are not a year transition leave every value alone', () => {
    const g = newGame();
    jumpTo(g, YEAR);
    const before = JSON.stringify(eco(g).market);
    tick(g, 5);
    g.act(g.current, { type: 'PAUSE_GAME' });
    g.act(g.current, { type: 'RESUME_GAME' });
    borrow(g, g.current, 'PERSONAL', 2000);
    expect(JSON.stringify(eco(g).market)).toBe(before);
  });

  it('the bank sells at the current market value; the deed price stays the original', () => {
    const g = newGame();
    eco(g).market.MUMBAI.value = 10200;
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    expect(g.state.turn.pending).toEqual({ kind: 'BUY', propertyKey: 'MUMBAI', price: 10200 });
    const r = g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['PROPERTY_PURCHASE', 10200]]);
    expect(g.balance('Asha')).toBe(START_CASH + REWARD - 10200);
  });

  it('a player who cannot afford the market price cannot buy', () => {
    const g = newGame();
    eco(g).market.MUMBAI.value = 30000;
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    expect(refusal(() => g.act('Asha', { type: 'BUY_PROPERTY' })).code).toBe('INSUFFICIENT_FUNDS');
  });

  it('leaves rent, building costs, mortgage payout and sell-to-bank on the printed deed', () => {
    const g = newGame();
    eco(g).market.MUMBAI.value = 20000;
    g.give('Asha', 'MUMBAI');
    expect(g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ amount: 7500 });
    g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    expect(g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'MORTGAGE', amount: 4250 });
    expect(g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'UNMORTGAGE', amount: 4675 });
    expect(g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'PROPERTY_SALE', amount: 4250 });
  });

  it('valuation shows original price, market value, trend, a five-year projection and purchasing power', () => {
    const g = newGame();
    expect(propertyValuation(g.state, 'MUMBAI')).toEqual({
      originalPrice: 8500,
      marketValue: 8500,
      lastChangePercent: null,
      trendPercent: 5,
      projectionYears: 5,
      projectedValue: 10800, // 8,500 × 1.05^5 = 10,848
      realValue: 8500,
      inflationYears: 0,
    });
    jumpTo(g, YEAR * 2);
    const v = propertyValuation(g.state, 'MUMBAI')!;
    expect(v).toMatchObject({ originalPrice: 8500, marketValue: 10300, lastChangePercent: 10, inflationYears: 2 }); // 8,500 → 9,400 → 10,300
    expect(v.realValue).toBe(9342); // 10,300 / 1.05²
    expect(v.projectedValue).toBe(13100); // recalculated from the new value: 10,300 × 1.05^5 = 13,146
    expect(propertyValuation(new TestGame(['Asha', 'Bilal']).state, 'MUMBAI')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('borrowing', () => {
  it('offers the five products at the credit-adjusted rate', () => {
    const g = newGame();
    const offers = loanOffers(g.state, g.id('Asha'));
    expect(offers.map((o) => [o.product, o.ratePercent, o.tenureYears, o.maxAmount])).toEqual([
      ['EMERGENCY', 19, 1, 5000],
      ['PERSONAL', 11, 3, 10000],
      ['SECURED', 7, 3, 0],
      ['LONG_TERM', 9, 5, 15000],
      ['FLEXIBLE', 6, 3, 10000],
    ]);
    expect(offers.find((o) => o.product === 'SECURED')?.blocked).toMatch(/own outright/);
    eco(g).credit[g.id('Asha')] = 600;
    expect(loanOffers(g.state, g.id('Asha')).map((o) => o.ratePercent)).toEqual([23, 15, 11, 13, 10]);
    eco(g).credit[g.id('Asha')] = 400;
    // A low score makes loans dearer, not unavailable.
    expect(loanOffers(g.state, g.id('Asha')).filter((o) => o.product !== 'SECURED').every((o) => o.blocked === null)).toBe(true);
  });

  it('creates the contract, pays out the principal, and schedules one payment per full year', () => {
    const g = newGame();
    tick(g, 5);
    tick(g, 5);
    const loan = borrow(g, 'Asha', 'PERSONAL', 10000);
    expect(g.balance('Asha')).toBe(START_CASH + REWARD + 10000);
    expect(loan).toMatchObject({ product: 'PERSONAL', principal: 10000, ratePercent: 11, marketRatePercent: 12, creditAdjustmentPercent: -1, rateType: 'FIXED', tenureYears: 3, status: 'ACTIVE', collateralKey: null, originClock: 10, originYear: 1 });
    const lines = buildSchedule(10000, 11, 3);
    expect(loan.installments.map((i) => [i.index, i.dueAt, i.principal, i.interest, i.status])).toEqual(lines.map((l, i) => [i + 1, 10 + (i + 1) * YEAR, l.principal, l.interest, 'SCHEDULED']));
    expect(clockLabel(eco(g), loan.installments[0]!.dueAt)).toBe('Year 2 · 13% through');
    expect(g.ledger[g.ledger.length - 1]).toMatchObject({ type: 'LOAN_DISBURSEMENT', amount: 10000, toPlayerId: g.id('Asha') });
  });

  it('enforces the minimum, the step, the product limit and the total limit', () => {
    const g = newGame();
    const take = (product: LoanProductKey, amount: number) => refusal(() => borrow(g, 'Asha', product, amount));
    expect(take('PERSONAL', 500).message).toMatch(/Minimum loan is ₹1,000/);
    expect(take('PERSONAL', 1250).message).toMatch(/steps of ₹500/);
    expect(take('EMERGENCY', 5500).message).toMatch(/up to ₹5,000/);
    expect(take('PERSONAL', 10500).code).toBe('LOAN_NOT_ALLOWED');
    borrow(g, 'Asha', 'LONG_TERM', 15000);
    expect(take('PERSONAL', 5500).message).toMatch(/borrow ₹5,000 more/);
    borrow(g, 'Asha', 'PERSONAL', 5000);
    expect(take('EMERGENCY', 1000).message).toMatch(/₹20,000 borrowing limit/);
    expect(eco(g).loans).toHaveLength(2);
    // The limit is per player.
    expect(borrow(g, 'Bilal', 'EMERGENCY', 1000).playerId).toBe(g.id('Bilal'));
  });

  it('refuses a contract whose rate is not the one the player confirmed', () => {
    const g = newGame();
    expect(refusal(() => g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 5000, expectedRatePercent: 9 }))).toMatchObject({ code: 'STALE_STATE' });
    expect(eco(g).loans).toEqual([]);
    expect(g.balance('Asha')).toBe(START_CASH);
  });

  it('never bills a loan just because the market year turned', () => {
    const g = newGame();
    jumpTo(g, YEAR - 2);
    const loan = borrow(g, 'Asha', 'PERSONAL', 5000);
    const r = tick(g, 4);
    expect(eco(g).year).toBe(2);
    expect(eventsOf(r, 'LOAN_INSTALLMENT_DUE')).toHaveLength(0);
    expect(loanOf(g, loan.id).installments.map((i) => i.status)).toEqual(['SCHEDULED', 'SCHEDULED', 'SCHEDULED']);
    expect(loanOf(g, loan.id).installments[0]!.dueAt).toBe(YEAR - 2 + YEAR);
  });

  it('an existing fixed loan keeps its signed rate when the score changes; new offers do not', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'PERSONAL', 5000);
    eco(g).credit[g.id('Asha')] = 500;
    jumpTo(g, YEAR + 1);
    expect(loanOf(g, loan.id).ratePercent).toBe(11);
    expect(loanOf(g, loan.id).installments[1]!.interest).toBe(buildSchedule(5000, 11, 3)[1]!.interest);
    expect(loanOffers(g.state, g.id('Asha')).find((o) => o.product === 'PERSONAL')?.ratePercent).toBe(18);
  });
});

describe('secured loans and collateral', () => {
  function withMumbai() {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    return g;
  }

  it('lends up to 50% of the market value of a property owned outright', () => {
    const g = withMumbai();
    expect(eligibleCollateral(g.state, g.id('Asha'))).toEqual([{ key: 'MUMBAI', marketValue: 8500, limit: 4000 }]);
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 4500, 'MUMBAI')).message).toMatch(/can secure up to ₹4,000/);
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 4000)).message).toMatch(/Choose the property/);
    const loan = borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI');
    expect(loan).toMatchObject({ collateralKey: 'MUMBAI', ratePercent: 7 });
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha')); // still hers
  });

  it('rejects property that is not eligible', () => {
    const g = withMumbai();
    g.give('Asha', 'DELHI', { mortgaged: true });
    g.give('Asha', 'AGRA', { houses: 1 });
    g.give('Bilal', 'MADRAS');
    expect(eligibleCollateral(g.state, g.id('Asha')).map((c) => c.key)).toEqual(['MUMBAI']);
    for (const key of ['DELHI', 'AGRA', 'MADRAS', 'COCHIN'] as const) {
      expect(refusal(() => borrow(g, 'Asha', 'SECURED', 1000, key)).message).toMatch(/can't be pledged/);
    }
    expect(refusal(() => g.act('Asha', { type: 'TAKE_INTERMEDIATE_LOAN', product: 'PERSONAL', amount: 1000, expectedRatePercent: 11, collateralKey: 'MUMBAI' })).message).toMatch(/takes no collateral/);
  });

  it('a property secures one loan at a time, and a pledged property cannot be mortgaged, sold, built on or traded', () => {
    const g = withMumbai();
    borrow(g, 'Asha', 'SECURED', 2000, 'MUMBAI');
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 1000, 'MUMBAI')).code).toBe('LOAN_NOT_ALLOWED');
    expect(eco(g).loans).toHaveLength(1);
    expect(refusal(() => g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' }))).toMatchObject({ code: 'MORTGAGE_NOT_ALLOWED' });
    expect(refusal(() => g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' })).message).toMatch(/Pledged as loan collateral/);
    expect(refusal(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' })).message).toMatch(/Pledged as loan collateral/);
    expect(refusal(() => g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 }))).toMatchObject({ code: 'TRADE_NOT_ALLOWED' });
    expect(propertyActionBlocker(g.state, g.id('Asha'), 'MUMBAI', 'MORTGAGE_PROPERTY')).toMatch(/can’t also be mortgaged/);
  });

  it('pledging closes open trade offers for that property, and blocks undoing its purchase', () => {
    const g = newGame();
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    const bought = g.act('Asha', { type: 'BUY_PROPERTY' });
    const actionId = bought.state.undoStack[0]!.actionId;
    g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: [], requestedPropertyKeys: ['MUMBAI'], offeredMoney: 9000, requestedMoney: 0 });
    borrow(g, 'Asha', 'SECURED', 1000, 'MUMBAI');
    expect(g.state.trades[0]!.status).toBe('EXPIRED');
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: actionId }))).toMatchObject({ code: 'UNDO_NOT_ALLOWED' });
  });

  it('a mortgaged property cannot be pledged, and repaying the loan releases the claim', () => {
    const g = withMumbai();
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 1000, 'MUMBAI')).code).toBe('LOAN_NOT_ALLOWED');
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    const loan = borrow(g, 'Asha', 'SECURED', 2000, 'MUMBAI');
    g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: 2000 });
    expect(loanOf(g, loan.id)).toMatchObject({ status: 'REPAID', collateralKey: null });
    expect(g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' }).transactions[0]).toMatchObject({ type: 'MORTGAGE', amount: 4250 });
  });
});

// ---------------------------------------------------------------------------

describe('repayments', () => {
  function withLoan(product: LoanProductKey = 'PERSONAL', amount = 9000) {
    const g = newGame();
    const loan = borrow(g, 'Asha', product, amount);
    return { g, id: loan.id, lines: loan.installments.map((i) => ({ principal: i.principal, interest: i.interest })) };
  }

  it('an installment falls due a full year after signing and can then be paid: principal and interest are separate ledger entries', () => {
    const { g, id, lines } = withLoan();
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).message).toMatch(/No installment is due/);
    jumpTo(g, YEAR - 1);
    expect(loanOf(g, id).installments[0]!.status).toBe('SCHEDULED');
    const due = tick(g, 2);
    expect(loanOf(g, id).installments[0]!.status).toBe('DUE');
    expect(eventsOf(due, 'LOAN_INSTALLMENT_DUE')).toHaveLength(1);
    expect(paymentsOwedNow(eco(g), g.id('Asha')).map((o) => [o.status, o.amount])).toEqual([['DUE', lines[0]!.principal + lines[0]!.interest]]);
    expect(paymentsOwedNow(eco(g), g.id('Bilal'))).toEqual([]);

    const cash = g.balance('Asha');
    const paid = g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id });
    expect(paid.transactions.map((t) => [t.type, t.amount, t.toPlayerId])).toEqual([
      ['LOAN_REPAYMENT', lines[0]!.principal, null],
      ['LOAN_INTEREST', lines[0]!.interest, null],
    ]);
    expect(g.balance('Asha')).toBe(cash - lines[0]!.principal - lines[0]!.interest);
    expect(loanOf(g, id).installments[0]).toMatchObject({ status: 'PAID' });
    expect(scoreOf(g, 'Asha')).toBe(710); // 705 after the clean Year 1, +5 for paying on time
    // Nothing more is due until the next anniversary.
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).code).toBe('LOAN_NOT_ALLOWED');
    expect(scoreOf(g, 'Asha')).toBe(710);
  });

  it('refuses a payment the player cannot afford, and nobody else can pay it', () => {
    const { g, id } = withLoan();
    jumpTo(g, YEAR);
    expect(refusal(() => g.act('Bilal', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).code).toBe('NOT_FOUND');
    const spare = g.balance('Asha') - 100;
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: spare });
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).code).toBe('INSUFFICIENT_FUNDS');
    expect(loanOf(g, id).installments[0]!.status).toBe('DUE');
    expect(g.balance('Asha')).toBe(100);
  });

  it('paying every installment on time repays the loan as agreed and rewards the score once', () => {
    const { g, id, lines } = withLoan('PERSONAL', 3000);
    for (let k = 1; k <= 3; k += 1) {
      jumpTo(g, YEAR * k);
      g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id });
    }
    const loan = loanOf(g, id);
    expect(loan.status).toBe('REPAID');
    expect(loan.installments.map((i) => i.status)).toEqual(['PAID', 'PAID', 'PAID']);
    const paid = g.ledger.filter((t) => t.fromPlayerId === g.id('Asha') && (t.type === 'LOAN_REPAYMENT' || t.type === 'LOAN_INTEREST'));
    expect(paid.filter((t) => t.type === 'LOAN_REPAYMENT').reduce((s, t) => s + t.amount, 0)).toBe(3000);
    expect(paid.reduce((s, t) => s + t.amount, 0)).toBe(lines.reduce((s, l) => s + l.principal + l.interest, 0));
    // 3 on-time payments, 2 clean years (Year 3's ends later), 1 full repayment.
    const kinds = eco(g).creditEvents.map((e) => e.type);
    expect(kinds.filter((k) => k === 'ON_TIME_PAYMENT')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'LOAN_REPAID')).toHaveLength(1);
    expect(scoreOf(g, 'Asha')).toBe(700 + eco(g).creditEvents.reduce((s, e) => s + e.delta, 0));
    expect(totalDebt(g.state, g.id('Asha'))).toBe(0);
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).code).toBe('LOAN_NOT_ALLOWED');
  });

  it('early repayment: principal plus the interest accrued on it, no penalty, schedule recalculated', () => {
    const { g, id } = withLoan('PERSONAL', 9000);
    jumpTo(g, 36); // half a loan year
    const quote = prepaymentQuote(eco(g), loanOf(g, id), 3000);
    expect(quote).toEqual({ principal: 3000, accruedInterest: accruedInterest(3000, 11, 36, YEAR), total: 3000 + 165, remainingPrincipal: 6000 });
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: id, amount: 3000 });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['LOAN_REPAYMENT', 3000],
      ['LOAN_INTEREST', 165],
    ]);
    expect(g.balance('Asha')).toBe(cash - 3165);
    const loan = loanOf(g, id);
    expect(loan.installments.map((i) => [i.principal, i.interest])).toEqual(buildSchedule(6000, 11, 3).map((l) => [l.principal, l.interest]));
    expect(loan.installments.map((i) => i.dueAt)).toEqual([YEAR, YEAR * 2, YEAR * 3]); // same due dates, smaller payments
    expect(loan.prepayments).toEqual([{ clock: 36, year: 1, principal: 3000, interest: 165 }]);
    expect(refusal(() => g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: id, amount: 6500 })).message).toMatch(/Only ₹6,000/);
  });

  it('full early repayment closes the loan as agreed', () => {
    const { g, id } = withLoan('EMERGENCY', 5000);
    jumpTo(g, 18);
    const r = g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: id, amount: 5000 });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['LOAN_REPAYMENT', 5000],
      ['LOAN_INTEREST', accruedInterest(5000, 19, 18, YEAR)],
    ]);
    expect(loanOf(g, id)).toMatchObject({ status: 'REPAID', installments: [] });
    expect(scoreOf(g, 'Asha')).toBe(715);
    expect(totalDebt(g.state, g.id('Asha'))).toBe(0);
  });

  it('an installment that is due must be paid before any early repayment', () => {
    const { g, id } = withLoan();
    jumpTo(g, YEAR);
    expect(refusal(() => g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: id, amount: 1000 })).message).toMatch(/due first/);
  });
});

describe('flexible-rate loan', () => {
  it('is reviewed on each anniversary: one drawn step, future installments re-amortized, settled ones untouched', () => {
    const g = newGame();
    jumpTo(g, 10);
    const loan = borrow(g, 'Asha', 'FLEXIBLE', 6000);
    expect(loan).toMatchObject({ ratePercent: 6, marketRatePercent: 7, creditAdjustmentPercent: -1, rateType: 'VARIABLE' });
    const first = { ...loan.installments[0]! };
    jumpTo(g, YEAR + 5); // Year 2 starts; no loan checkpoint yet
    const r = jumpTo(g, YEAR + 10, [0.95]); // anniversary: +2 points
    const after = loanOf(g, loan.id);
    expect(after).toMatchObject({ ratePercent: 8, marketRatePercent: 9, creditAdjustmentPercent: -1 });
    expect(after.installments[0]).toMatchObject({ status: 'DUE', principal: first.principal, interest: first.interest });
    const remaining = 6000 - first.principal;
    expect(after.installments.slice(1).map((i) => [i.principal, i.interest])).toEqual(buildSchedule(remaining, 8, 2).map((l) => [l.principal, l.interest]));
    expect(after.rateHistory).toEqual([
      { clock: 10, year: 1, movePercent: 0, ratePercent: 6 },
      { clock: YEAR + 10, year: 2, movePercent: 2, ratePercent: 8 },
    ]);
    expect(eventsOf(r, 'LOAN_RATE_CHANGED')).toHaveLength(1);

    // No reroll between anniversaries, whatever happens.
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    tick(g, 6);
    tick(g, 6);
    expect(loanOf(g, loan.id).ratePercent).toBe(8);
    expect(loanOf(g, loan.id).rateHistory).toHaveLength(2);

    // Second anniversary: −2 points. Year 3 has started by now, so its 26 market draws come first.
    jumpTo(g, YEAR * 2 + 5);
    jumpTo(g, YEAR * 2 + 10, [0.01]);
    const last = loanOf(g, loan.id);
    expect(last).toMatchObject({ ratePercent: 6, marketRatePercent: 7 });
    expect(last.installments[2]).toMatchObject({ status: 'SCHEDULED', principal: after.installments[2]!.principal });
    expect(last.installments[2]!.interest).toBe(buildSchedule(after.installments[2]!.principal, 6, 1)[0]!.interest);
    // The final installment has no review after it: nothing left to reprice.
    jumpTo(g, YEAR * 3 + 5);
    jumpTo(g, YEAR * 3 + 10, [0.95]);
    expect(loanOf(g, loan.id).rateHistory).toHaveLength(3);
  });

  it('keeps the market component within 4%–30%', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'FLEXIBLE', 3000);
    loanOf(g, loan.id).marketRatePercent = 5;
    loanOf(g, loan.id).ratePercent = 4;
    jumpTo(g, YEAR, [...Array(PROPERTY_KEYS.length).fill(0.5), 0.01]);
    expect(loanOf(g, loan.id)).toMatchObject({ marketRatePercent: 4, ratePercent: 4 });
  });

  it('fixed-rate loans are never reviewed', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'PERSONAL', 3000);
    const r = jumpTo(g, YEAR, [...Array(PROPERTY_KEYS.length).fill(0.5), 0.95]);
    expect(eventsOf(r, 'LOAN_RATE_CHANGED')).toHaveLength(0);
    expect(loanOf(g, loan.id).rateHistory).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('missed payments, grace and default', () => {
  function dueLoan(product: LoanProductKey = 'PERSONAL', amount = 9000, collateralKey?: PropertyKey) {
    const g = newGame();
    if (collateralKey) g.give('Asha', collateralKey);
    const loan = borrow(g, 'Asha', product, amount, collateralKey);
    jumpTo(g, YEAR);
    return { g, id: loan.id };
  }

  it('an unpaid installment turns overdue after its payment window: −20 once, borrowing blocked, loan still active', () => {
    const { g, id } = dueLoan();
    expect(installmentDeadlines(eco(g), loanOf(g, id).installments[0]!)).toEqual({ overdueAt: YEAR + WINDOW, defaultAt: YEAR + WINDOW + YEAR });
    jumpTo(g, YEAR + WINDOW - 1);
    expect(loanOf(g, id).installments[0]!.status).toBe('DUE');
    expect(scoreOf(g, 'Asha')).toBe(705); // the clean Year 1
    const r = tick(g, 2);
    expect(loanOf(g, id).installments[0]!.status).toBe('OVERDUE');
    expect(eventsOf(r, 'LOAN_INSTALLMENT_OVERDUE')).toHaveLength(1);
    expect(scoreOf(g, 'Asha')).toBe(685);
    expect(loanOf(g, id).status).toBe('ACTIVE');
    expect(g.player('Asha').status).toBe('ACTIVE');
    expect(borrowingBlock(eco(g), g.id('Asha'))).toMatch(/overdue payment/);
    expect(refusal(() => borrow(g, 'Asha', 'EMERGENCY', 1000)).code).toBe('LOAN_NOT_ALLOWED');
    // Later rolls inside the grace period change nothing more.
    tick(g, 12);
    tick(g, 12);
    expect(scoreOf(g, 'Asha')).toBe(685);
    expect(eco(g).creditEvents.filter((e) => e.type === 'INSTALLMENT_OVERDUE')).toHaveLength(1);
    // The amount owed is exactly the installment: nothing forgiven, nothing added.
    const inst = loanOf(g, id).installments[0]!;
    expect(paymentsOwedNow(eco(g), g.id('Asha'))[0]).toMatchObject({ status: 'OVERDUE', amount: inst.principal + inst.interest, deadline: YEAR + WINDOW + YEAR });
  });

  it('catching up within grace: +5 once, the late payment stays on record, borrowing reopens', () => {
    const { g, id } = dueLoan();
    jumpTo(g, YEAR + WINDOW + 30);
    const inst = loanOf(g, id).installments[0]!;
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id });
    expect(g.balance('Asha')).toBe(cash - inst.principal - inst.interest);
    expect(eventsOf(r, 'LOAN_INSTALLMENT_CAUGHT_UP')).toHaveLength(1);
    expect(loanOf(g, id).installments[0]!.status).toBe('CAUGHT_UP');
    expect(scoreOf(g, 'Asha')).toBe(690);
    expect(eco(g).creditEvents.map((e) => [e.type, e.before, e.after])).toEqual([
      ['CLEAN_YEAR', 700, 705],
      ['INSTALLMENT_OVERDUE', 705, 685],
      ['CAUGHT_UP', 685, 690],
    ]);
    expect(borrowingBlock(eco(g), g.id('Asha'))).toBeNull();
    expect(borrow(g, 'Asha', 'EMERGENCY', 1000).status).toBe('ACTIVE');
    // Passing the old default deadline now does nothing.
    jumpTo(g, YEAR + WINDOW + YEAR + 1);
    expect(loanOf(g, id).status).toBe('ACTIVE');
  });

  it('unsecured default after a full year of grace: −75 once, whole balance payable, nothing seized, not bankrupt', () => {
    const { g, id } = dueLoan('PERSONAL', 9000);
    g.give('Asha', 'DELHI');
    const lines = buildSchedule(9000, 11, 3);
    jumpTo(g, YEAR + WINDOW + YEAR - 1);
    expect(loanOf(g, id).status).toBe('ACTIVE');
    const cash = g.balance('Asha');
    const r = tick(g, 2);
    const loan = loanOf(g, id);
    expect(loan.status).toBe('DEFAULTED');
    // Installments 1 and 2 had fallen due; installment 3's principal had run 19/72 of its year.
    const owed = lines[0]!.principal + lines[0]!.interest + lines[1]!.principal + lines[1]!.interest + lines[2]!.principal + accruedInterest(lines[2]!.principal, 11, WINDOW + 1, YEAR);
    expect(loan.defaultBalance).toBe(owed);
    expect(loan.installments.map((i) => i.status)).toEqual(['DEFAULTED', 'DEFAULTED', 'DEFAULTED']);
    expect(eventsOf(r, 'LOAN_DEFAULTED')).toHaveLength(1);
    expect(eventsOf(r, 'COLLATERAL_SEIZED')).toHaveLength(0);
    // −20 for each of the two installments that went overdue, then −75 for the default.
    expect(eco(g).creditEvents.map((e) => e.type)).toEqual(['CLEAN_YEAR', 'INSTALLMENT_OVERDUE', 'INSTALLMENT_OVERDUE', 'LOAN_DEFAULT']);
    expect(scoreOf(g, 'Asha')).toBe(705 - 20 - 20 - 75);
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Asha'));
    expect(g.player('Asha').status).toBe('ACTIVE');
    // A default takes no cash: the only money that moved is the roll's own Start reward.
    expect(g.balance('Asha')).toBe(cash + startRewards(r, g.id('Asha')));
    expect(totalDebt(g.state, g.id('Asha'))).toBe(owed);
    expect(borrowingBlock(eco(g), g.id('Asha'))).toMatch(/in default/);

    // Further play never defaults it again or grows the balance.
    jumpTo(g, YEAR * 4);
    expect(loanOf(g, id).defaultBalance).toBe(owed);
    expect(eco(g).creditEvents.filter((e) => e.type === 'LOAN_DEFAULT')).toHaveLength(1);
  });

  it('a defaulted balance can be paid down in parts; clearing it resolves the default', () => {
    const { g, id } = dueLoan('EMERGENCY', 2000);
    jumpTo(g, YEAR + WINDOW + YEAR);
    const owed = loanOf(g, id).defaultBalance;
    expect(owed).toBe(2000 + 380);
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: id })).message).toMatch(/in default/);
    expect(refusal(() => g.act('Asha', { type: 'PAY_DEFAULTED_LOAN', loanId: id, amount: owed + 1 })).code).toBe('VALIDATION');
    g.act('Asha', { type: 'PAY_DEFAULTED_LOAN', loanId: id, amount: 1000 });
    expect(loanOf(g, id)).toMatchObject({ status: 'DEFAULTED', defaultBalance: owed - 1000 });
    expect(borrowingBlock(eco(g), g.id('Asha'))).not.toBeNull();
    const score = scoreOf(g, 'Asha');
    g.act('Asha', { type: 'PAY_DEFAULTED_LOAN', loanId: id, amount: owed - 1000 });
    expect(loanOf(g, id)).toMatchObject({ status: 'SETTLED', defaultBalance: 0 });
    expect(borrowingBlock(eco(g), g.id('Asha'))).toBeNull();
    expect(scoreOf(g, 'Asha')).toBe(score); // settling a default is not "repaid as agreed"
    expect(totalDebt(g.state, g.id('Asha'))).toBe(0);
  });

  it('secured default: the bank takes the property at market value, clears the debt and returns the surplus', () => {
    const { g, id } = dueLoan('SECURED', 4000, 'MUMBAI');
    jumpTo(g, YEAR + WINDOW + YEAR - 1);
    const cash = g.balance('Asha');
    const r = tick(g, 2);
    const loan = loanOf(g, id);
    const value = eco(g).market.MUMBAI.value;
    const lines = buildSchedule(4000, 7, 3);
    const owed = lines[0]!.principal + lines[0]!.interest + lines[1]!.principal + lines[1]!.interest + lines[2]!.principal + accruedInterest(lines[2]!.principal, 7, WINDOW + 1, YEAR);
    expect(value).toBeGreaterThan(owed);
    expect(loan).toMatchObject({ status: 'SETTLED', defaultBalance: 0, collateralKey: null, settlement: { propertyKey: 'MUMBAI', value, applied: owed, surplus: value - owed } });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: null, mortgaged: false, houses: 0, hotel: false });
    expect(r.transactions.filter((t) => t.type === 'COLLATERAL_SURPLUS').map((t) => [t.toPlayerId, t.amount, t.propertyKey])).toEqual([[g.id('Asha'), value - owed, 'MUMBAI']]);
    expect(g.balance('Asha')).toBe(cash + (value - owed) + startRewards(r, g.id('Asha')));
    expect(eventsOf(r, 'COLLATERAL_SEIZED')).toHaveLength(1);
    expect(scoreOf(g, 'Asha')).toBe(705 - 20 - 20 - 75);
    expect(borrowingBlock(eco(g), g.id('Asha'))).toBeNull(); // settled in full by the collateral

    // The property is the bank's again and is seized exactly once.
    jumpTo(g, YEAR * 4);
    expect(g.results.flatMap((x) => x.events).filter((e) => e.type === 'COLLATERAL_SEIZED')).toHaveLength(1);
    expect(g.ledger.filter((t) => t.type === 'COLLATERAL_SURPLUS')).toHaveLength(1);
  });

  it('secured default with collateral worth too little: the shortfall stays owed', () => {
    const { g, id } = dueLoan('SECURED', 4000, 'MUMBAI');
    jumpTo(g, YEAR + WINDOW + YEAR - 1);
    eco(g).market.MUMBAI.value = 1500;
    const r = tick(g, 2);
    const loan = loanOf(g, id);
    const lines = buildSchedule(4000, 7, 3);
    const owed = lines[0]!.principal + lines[0]!.interest + lines[1]!.principal + lines[1]!.interest + lines[2]!.principal + accruedInterest(lines[2]!.principal, 7, WINDOW + 1, YEAR);
    expect(loan).toMatchObject({ status: 'DEFAULTED', defaultBalance: owed - 1500, collateralKey: null, settlement: { value: 1500, applied: 1500, surplus: 0 } });
    expect(g.state.properties.MUMBAI.ownerId).toBeNull();
    expect(r.transactions.some((t) => t.type === 'COLLATERAL_SURPLUS')).toBe(false);
    expect(totalDebt(g.state, g.id('Asha'))).toBe(owed - 1500);
    expect(borrowingBlock(eco(g), g.id('Asha'))).toMatch(/in default/);
  });

  it('clamps the score at 300 and 850', () => {
    const { g, id } = dueLoan('EMERGENCY', 1000);
    eco(g).credit[g.id('Asha')] = 310;
    jumpTo(g, YEAR + WINDOW + YEAR);
    expect(scoreOf(g, 'Asha')).toBe(300);
    expect(loanOf(g, id).status).toBe('DEFAULTED');

    const h = newGame();
    const loan = borrow(h, 'Asha', 'EMERGENCY', 1000);
    eco(h).credit[h.id('Asha')] = 848;
    jumpTo(h, YEAR);
    h.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    expect(scoreOf(h, 'Asha')).toBe(850);
  });
});

describe('clean-year reward', () => {
  it('+5 at year end for a borrower with nothing overdue — once per year, never for a non-borrower', () => {
    const g = newGame();
    jumpTo(g, 30);
    borrow(g, 'Asha', 'LONG_TERM', 5000);
    const r = jumpTo(g, YEAR);
    expect(eco(g).year).toBe(2);
    expect(eco(g).creditEvents.map((e) => [e.playerId, e.type, e.year])).toEqual([[g.id('Asha'), 'CLEAN_YEAR', 2]]);
    expect(scoreOf(g, 'Asha')).toBe(705);
    expect(scoreOf(g, 'Bilal')).toBe(700);
    expect(eventsOf(r, 'CREDIT_SCORE_CHANGED')).toHaveLength(1);
    tick(g, 12);
    tick(g, 12);
    expect(eco(g).creditEvents).toHaveLength(1);
  });

  it('is withheld for a year in which an installment went overdue, even if it was caught up', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'LONG_TERM', 5000);
    jumpTo(g, YEAR); // Year 2 begins: clean Year 1
    jumpTo(g, YEAR + WINDOW); // overdue in Year 2
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    jumpTo(g, YEAR * 2 - 1); // still Year 2, one space before installment 2 falls due
    const before = eco(g).creditEvents.length;
    tick(g, 2); // Year 3 begins
    expect(eco(g).year).toBe(3);
    expect(eco(g).creditEvents.slice(before).some((e) => e.type === 'CLEAN_YEAR')).toBe(false);
    expect(eco(g).creditEvents.filter((e) => e.type === 'CLEAN_YEAR')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('financial position', () => {
  it('net worth = cash + market value + buildings at cost − mortgage redemption − loans; liquidity is separate', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI', { mortgaged: true });
    g.give('Asha', 'AGRA', { houses: 2 });
    eco(g).market.MUMBAI.value = 10000;
    const loan = borrow(g, 'Asha', 'PERSONAL', 5000);
    const o = financialOverview(g.state, g.id('Asha'))!;
    const delhi = getDeed('DELHI').price;
    const agra = getDeed('AGRA');
    expect(o.cash).toBe(START_CASH + 5000);
    expect(o.propertyValue).toBe(10000 + delhi + agra.price);
    expect(o.buildingValue).toBe(2 * (agra.kind === 'CITY' ? agra.houseCost : 0));
    expect(o.mortgageRedemption).toBe(unmortgageCost('DELHI'));
    expect(o.netAssets).toBe(o.cash + o.propertyValue + o.buildingValue - o.mortgageRedemption);
    expect(o.loanPrincipal).toBe(5000);
    expect(o.netWorth).toBe(o.netAssets - 5000);
    expect(netWorth(g.state, g.id('Asha'))).toBe(o.netWorth);
    expect(o.debtRatio).toBeCloseTo(5000 / o.netAssets, 10);
    expect(o).toMatchObject({ creditScore: 700, creditBand: 'Good', propertyCount: 3, mortgagedCount: 1, overdueAmount: 0, borrowingBlocked: null, borrowingCapacity: 15000 });
    const first = loan.installments[0]!;
    expect(o.nextPayment).toMatchObject({ status: 'SCHEDULED', amount: first.principal + first.interest, deadline: YEAR });
    expect(o.cashAfterNextPayment).toBe(o.cash - first.principal - first.interest);
  });

  it('interest that has fallen due is a liability; interest not yet due is not', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'PERSONAL', 9000);
    expect(totalDebt(g.state, g.id('Asha'))).toBe(9000);
    jumpTo(g, YEAR);
    expect(totalDebt(g.state, g.id('Asha'))).toBe(9000 + loanOf(g, loan.id).installments[0]!.interest);
  });

  it('an early end ranks players by Intermediate net worth', () => {
    const g = newGame();
    g.give('Bilal', 'MUMBAI');
    eco(g).market.MUMBAI.value = 100;
    const r = g.act('Asha', { type: 'END_GAME' });
    const finished = r.events.find((e) => e.type === 'GAME_FINISHED') as unknown as { payload: { standings: { playerId: string; netWorth: number }[] } };
    expect(finished.payload.standings).toEqual([
      { playerId: g.id('Bilal'), netWorth: START_CASH + 100 },
      { playerId: g.id('Asha'), netWorth: START_CASH },
    ]);
  });
});

describe('bankruptcy and leaving', () => {
  it('bankruptcy (the game’s own rule) writes off the player’s loans and drops the collateral claim', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'DELHI');
    g.give('Bilal', 'MUMBAI', { hotel: true });
    const loan = borrow(g, 'Asha', 'SECURED', 1000, 'DELHI');
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: g.balance('Asha') - 100 });
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(loanOf(g, loan.id)).toMatchObject({ status: 'WRITTEN_OFF', collateralKey: null });
    expect(g.state.properties.DELHI.ownerId).toBeNull();
    // The property is free of any claim for its next owner.
    g.give('Bilal', 'DELHI');
    expect(eligibleCollateral(g.state, g.id('Bilal')).map((c) => c.key)).toContain('DELHI');
    // Nothing further is processed for the bankrupt player's loan.
    jumpTo(g, 108 * 3);
    expect(loanOf(g, loan.id).status).toBe('WRITTEN_OFF');
    expect(eco(g).creditEvents.filter((e) => e.playerId === g.id('Asha'))).toEqual([]);
  });

  it('a default does not make anyone bankrupt, and bankruptcy still needs an unpayable turn payment', () => {
    const g = newGame();
    borrow(g, 'Asha', 'EMERGENCY', 1000);
    jumpTo(g, YEAR + WINDOW + YEAR);
    expect(g.player('Asha').status).toBe('ACTIVE');
    expect(refusal(() => g.act(g.current, { type: 'DECLARE_BANKRUPTCY' })).code).toBe('INVALID_PHASE');
  });

  it('a player who left keeps their loan frozen: no checkpoints, no score changes', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    const loan = borrow(g, 'Chitra', 'PERSONAL', 3000);
    g.act('Chitra', { type: 'LEAVE_GAME' });
    jumpTo(g, 108 * 4);
    expect(loanOf(g, loan.id).installments.map((i) => i.status)).toEqual(['SCHEDULED', 'SCHEDULED', 'SCHEDULED']);
    expect(eco(g).creditEvents).toEqual([]);
  });
});

describe('credit history', () => {
  it('records every change with its cause, the loan, and the score before and after', () => {
    const g = newGame();
    const loan = borrow(g, 'Asha', 'EMERGENCY', 1000);
    jumpTo(g, YEAR);
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    expect(eco(g).creditEvents.map((e) => ({ id: e.id, type: e.type, delta: e.delta, before: e.before, after: e.after, loanId: e.loanId, year: e.year, reason: e.reason }))).toEqual([
      { id: `CLEAN_YEAR:${g.id('Asha')}:1`, type: 'CLEAN_YEAR', delta: 5, before: 700, after: 705, loanId: null, year: 2, reason: 'Finished a financial year with nothing overdue' },
      { id: `ON_TIME_PAYMENT:${loan.id}:1`, type: 'ON_TIME_PAYMENT', delta: 5, before: 705, after: 710, loanId: loan.id, year: 2, reason: 'Paid an installment on time' },
      { id: `LOAN_REPAID:${loan.id}`, type: 'LOAN_REPAID', delta: 15, before: 710, after: 725, loanId: loan.id, year: 2, reason: 'Repaid a loan in full, as agreed' },
    ]);
    expect(new Set(eco(g).creditEvents.map((e) => e.id)).size).toBe(eco(g).creditEvents.length);
  });
});

describe('persistence', () => {
  /** What storing a document as Postgres jsonb does to it: values survive, key order does not. */
  function stored<T>(value: T): T {
    const reorder = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reorder);
      if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1));
        return Object.fromEntries(entries.map(([k, x]) => [k, reorder(x)]));
      }
      return v;
    };
    return reorder(JSON.parse(JSON.stringify(value))) as T;
  }

  it('the economy is plain JSON, and a game reloaded from storage plays on exactly as the live one', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI');
    borrow(g, 'Asha', 'FLEXIBLE', 3000);
    borrow(g, 'Bilal', 'PERSONAL', 6000);
    jumpTo(g, YEAR + 6);
    g.act('Bilal', { type: 'PAY_LOAN_INSTALLMENT', loanId: eco(g).loans[2]!.id });

    const reloaded = { ...g.state, intermediate: stored(g.state.intermediate) };
    expect(reloaded.intermediate).toEqual(g.state.intermediate);
    expect(JSON.parse(JSON.stringify(g.state.intermediate))).toEqual(g.state.intermediate); // nothing JSON would drop

    // The same next roll, with the same server randomness, from the live state and from the reloaded one.
    const name = g.current;
    for (const state of [g.state, reloaded]) state.players.find((p) => p.id === g.id(name))!.position = BOARD_SIZE - 12;
    const play = (state: typeof g.state) => {
      let n = 0;
      let r = 0;
      const draws = [faceToRandom(6), faceToRandom(6), 0.05, 0.9, 0.3, 0.7];
      return applyAction(state, g.id(name), { type: 'ROLL_DICE' }, {
        actionId: '00000000-0000-4000-8000-0000000000aa',
        now: '2026-01-01T12:00:00.000Z',
        random: () => draws[r++] ?? 0.5,
        newId: () => `00000000-0000-4000-9000-${String((n += 1)).padStart(12, '0')}`,
      });
    };
    const a = play(g.state);
    const b = play(reloaded);
    expect(b.state.intermediate).toEqual(a.state.intermediate);
    expect(b.state.players).toEqual(a.state.players);
    expect(b.transactions).toEqual(a.transactions);
    expect(b.events).toEqual(a.events);
  });

  it('every device computes the same figures from the same stored state', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    borrow(g, 'Asha', 'SECURED', 4000, 'MUMBAI');
    jumpTo(g, YEAR * 2 + 20);
    const copy = stored(g.state);
    for (const name of ['Asha', 'Bilal']) {
      expect(financialOverview(copy, g.id(name))).toEqual(financialOverview(g.state, g.id(name)));
      expect(loanOffers(copy, g.id(name))).toEqual(loanOffers(g.state, g.id(name)));
    }
    for (const key of PROPERTY_KEYS) expect(propertyValuation(copy, key)).toEqual(propertyValuation(g.state, key));
  });
});
