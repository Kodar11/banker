/**
 * The agreed economic rules (docs/economy-rules.md), driven through the real engine (applyAction):
 * final net worth and the winner, loan maturity and default, credit score, bankruptcy and the chance
 * to raise funds, gifts and trades while a payment is owed, and leaving the game.
 */
import { describe, expect, it } from 'vitest';
import {
  accruedInterest,
  balanceSheet,
  bankruptcyBlocker,
  BOARD_SIZE,
  BUSINESS_MVP_RULES as RULES,
  buildingCost,
  classicBorrowingBlock,
  classicLoanStanding,
  creditScoreOf,
  crisisCheckpointClock,
  financialOverview,
  GameError,
  gameClock,
  getDeed,
  INTERMEDIATE_RULES as IR,
  loanOffers,
  mandatoryPaymentsOwed,
  netWorth,
  offeredRate,
  positionOfSpecial,
  PROPERTY_KEYS,
  formatINR,
  propertyLiquidationValue,
  raiseFundsOptions,
  rankStandings,
  sellBuildingRefund,
  unmortgageCost,
  type EngineResult,
  type GameAction,
  type IntermediateLoan,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';
import { stateViolations } from './invariantChecks.ts';

const START = RULES.startingCash;
/** Two starting players: one financial year = 72 spaces on the shared clock; the payment window is a quarter of it. */
const YEAR = 72;
const WINDOW = 18;

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GameError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

const types = (r: EngineResult) => r.events.map((e) => e.type);
const sound = (g: TestGame) => expect(stateViolations(g.state, g.ledger)).toEqual([]);
const finished = (r: EngineResult) =>
  r.events.find((e) => e.type === 'GAME_FINISHED')!.payload as { winnerId: string | null; winnerIds: string[]; sharedVictory: boolean; standings: { playerId: string; netWorth: number; liabilities: number; rank: number }[] };

/** Leaves `name` with exactly `keep` in cash by handing the rest to `to` (allowed: nothing is owed yet). */
function leaveWith(g: TestGame, name: string, keep: number, to: string): void {
  const spare = g.balance(name) - keep;
  if (spare > 0) g.act(name, { type: 'TRANSFER_MONEY', toPlayerId: g.id(to), amount: spare });
}

/** The current player rolls 2 from two squares before Start (lands on Start: nothing to resolve) and ends the turn. */
function lap(g: TestGame): { who: string; result: EngineResult } {
  const who = g.current;
  g.placeAt(who, BOARD_SIZE - 2);
  const result = g.roll(who, 1, 1);
  g.act(who, { type: 'END_TURN' });
  return { who, result };
}

/** Plays laps until `name` has passed Start `count` more times; returns the results of `name`'s own rolls. */
function lapsOf(g: TestGame, name: string, count: number): EngineResult[] {
  const mine: EngineResult[] = [];
  while (mine.length < count) {
    const { who, result } = lap(g);
    if (who === name) mine.push(result);
  }
  return mine;
}

// Capital Mode helpers (the same test surgery tests/engine/intermediateMode.test.ts uses).
const capital = (names = ['Asha', 'Bilal']) => new TestGame(names, { mode: 'intermediate' });
const eco = (g: TestGame): IntermediateState => g.state.intermediate!;
const scoreOf = (g: TestGame, name: string) => creditScoreOf(eco(g), g.id(name));
const loanOf = (g: TestGame, id: string): IntermediateLoan => eco(g).loans.find((l) => l.id === id)!;

function tick(g: TestGame): EngineResult {
  const name = g.current;
  g.placeAt(name, BOARD_SIZE - 2);
  g.queueRandom(faceToRandom(1), faceToRandom(1));
  const result = g.act(name, { type: 'ROLL_DICE' });
  g.act(name, { type: 'END_TURN' });
  return result;
}

function jumpTo(g: TestGame, target: number): EngineResult {
  const movement = eco(g).movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = target - 2;
  const ins = eco(g).insurance!;
  while (crisisCheckpointClock(eco(g), ins.nextCheckpoint) <= target) ins.nextCheckpoint += 1;
  const result = tick(g);
  expect(gameClock(eco(g))).toBe(target);
  return result;
}

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number, collateralKeys?: PropertyKey[]): IntermediateLoan {
  const expectedRatePercent = offeredRate(product, scoreOf(g, name)).ratePercent;
  g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKeys ? { collateralKeys } : {}) });
  return eco(g).loans[eco(g).loans.length - 1]!;
}

// ---------------------------------------------------------------------------
// Final net worth
// ---------------------------------------------------------------------------

describe('final net worth — Classic', () => {
  it('cash + deed prices + buildings at full cost − the mortgage value once − loans; borrowing alone changes nothing', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Asha', 'MUMBAI', { houses: 2 });
    g.give('Asha', 'DELHI', { mortgaged: true });
    const before = netWorth(g.state, g.id('Asha'));
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    const sheet = balanceSheet(g.state, g.id('Asha'));
    const mumbai = getDeed('MUMBAI');
    expect(sheet).toEqual({
      cash: START + 5000,
      propertyValue: mumbai.price + getDeed('DELHI').price,
      buildingValue: 2 * (mumbai.kind === 'CITY' ? mumbai.houseCost : 0),
      assets: START + 5000 + mumbai.price + getDeed('DELHI').price + 15000,
      mortgages: getDeed('DELHI').mortgageValue,
      loans: 5000,
      crisisBills: 0,
      liabilities: getDeed('DELHI').mortgageValue + 5000,
      netWorth: before,
    });
    expect(netWorth(g.state, g.id('Asha'))).toBe(sheet.assets - sheet.liabilities);
  });

  it('a building counts at its full construction cost; selling it pays half (rounded down) and costs exactly the other half', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Asha', 'MUMBAI');
    const worth = () => netWorth(g.state, g.id('Asha'));
    const before = worth();
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    expect(worth()).toBe(before);
    const sold = g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    expect(sold.transactions.map((t) => [t.type, t.amount])).toEqual([['HOUSE_SALE', 3750]]);
    expect(worth()).toBe(before - 3750);
    // A hotel is sold whole: half of the hotel and the three houses it replaced.
    g.give('Asha', 'CALCUTTA', { hotel: true });
    const hotel = worth();
    const sale = g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'CALCUTTA' });
    const cost = buildingCost({ key: 'CALCUTTA', ownerId: g.id('Asha'), houses: 0, hotel: true, mortgaged: false });
    expect(sale.transactions.map((t) => [t.type, t.amount])).toEqual([['HOTEL_SALE', Math.floor(cost * RULES.building.sellBackRate)]]);
    expect(worth()).toBe(hotel - (cost - Math.floor(cost * RULES.building.sellBackRate)));
    // The rounding rule holds for every deed: half the cost, rounded down.
    for (const key of PROPERTY_KEYS) {
      const deed = getDeed(key);
      if (deed.kind !== 'CITY') continue;
      expect(sellBuildingRefund(key, { key, ownerId: 'x', houses: 1, hotel: false, mortgaged: false })).toBe(Math.floor(deed.houseCost / 2));
    }
    sound(g);
  });

  it('loan interest charged at Start and unpaid is a liability once — paying it moves cash and liability together', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 });
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeAt('Asha', 34);
    g.roll('Asha', 2, 3); // past Start (+1,500): ₹2,000 interest due, ₹1,600 in hand
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'LOAN_INTEREST', amount: 2000 });
    expect(balanceSheet(g.state, g.id('Asha')).loans).toBe(20000 + 2000);
    const owing = netWorth(g.state, g.id('Asha'));
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 400 });
    g.act('Asha', { type: 'PAY_INTEREST' });
    expect(balanceSheet(g.state, g.id('Asha')).loans).toBe(20000);
    expect(netWorth(g.state, g.id('Asha'))).toBe(owing + 400); // the gift only
    sound(g);
  });
});

describe('final net worth — Capital', () => {
  it('market values + buildings at cost − redemption − loan payoff − a crisis bill: each counted once, and the dashboard agrees', () => {
    const g = capital();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI', { mortgaged: true });
    g.give('Asha', 'AGRA', { houses: 2 });
    const loan = borrow(g, 'Asha', 'PERSONAL', 15000);
    jumpTo(g, YEAR + 12); // installment 1 due (inside its payment window), and 12 spaces of the next loan year accrued
    eco(g).market.MUMBAI.value = 10000; // after the Year 2 market move
    const inst = loanOf(g, loan.id).installments[0]!;
    expect(inst.status).toBe('DUE');
    eco(g).insurance!.crises.push({
      id: 'crisis-1', checkpoint: 99, checkpointClock: 0, year: 2, propertyKey: 'MUMBAI', ownerId: g.id('Asha'), mortgaged: false,
      amount: 3000, paid: 0, policyId: null, status: 'PENDING', createdAt: g.ctx().now, settledAt: null,
    });
    const sheet = balanceSheet(g.state, g.id('Asha'));
    const agra = getDeed('AGRA');
    const accrued = accruedInterest(15000 - inst.principal, 12, 12, YEAR);
    expect(accrued).toBeGreaterThan(0);
    expect(sheet.propertyValue).toBe(10000 + eco(g).market.DELHI.value + eco(g).market.AGRA.value);
    expect(sheet.buildingValue).toBe(2 * (agra.kind === 'CITY' ? agra.houseCost : 0));
    expect(sheet.mortgages).toBe(unmortgageCost('DELHI'));
    // Installment 1 (principal + its interest), the principal not yet due, and this year's accrued interest on it.
    expect(sheet.loans).toBe(15000 + inst.interest + accrued);
    expect(sheet.crisisBills).toBe(3000);
    expect(sheet.netWorth).toBe(sheet.cash + sheet.propertyValue + sheet.buildingValue - sheet.mortgages - sheet.loans - 3000);
    const overview = financialOverview(g.state, g.id('Asha'))!;
    expect(overview).toMatchObject({ netWorth: sheet.netWorth, loanLiability: sheet.loans, accruedInterest: accrued, crisisOwed: 3000 });
  });

  it('a partial early repayment lowers cash and liability by the same amount: net worth does not move', () => {
    const g = capital();
    const loan = borrow(g, 'Asha', 'PERSONAL', 15000);
    jumpTo(g, 36);
    const before = balanceSheet(g.state, g.id('Asha'));
    const r = g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: 5000 });
    const paid = r.transactions.reduce((s, t) => s + t.amount, 0);
    const after = balanceSheet(g.state, g.id('Asha'));
    expect(after.cash).toBe(before.cash - paid);
    expect(after.loans).toBe(before.loans - paid);
    expect(after.netWorth).toBe(before.netWorth);
  });

  it('a defaulted loan is its default balance — never the balance plus the installments it already contains', () => {
    const g = capital();
    const loan = borrow(g, 'Asha', 'PERSONAL', 15000);
    jumpTo(g, YEAR + WINDOW + YEAR);
    expect(loanOf(g, loan.id).status).toBe('DEFAULTED');
    expect(balanceSheet(g.state, g.id('Asha')).loans).toBe(loanOf(g, loan.id).defaultBalance);
  });
});

describe('a loan signed just before the end counts in full', () => {
  it.each(['classic', 'intermediate'] as const)('%s: same net worth as before borrowing, the debt in the liabilities — and the tie-break sees it', (mode) => {
    const g = new TestGame(['Asha', 'Bilal'], { mode });
    // Each mode's own loan sizes: Classic lends from ₹1,000, Capital from ₹10,000.
    const amount = mode === 'classic' ? 5000 : 10000;
    if (mode === 'classic') g.act('Asha', { type: 'REQUEST_LOAN', amount });
    else borrow(g, 'Asha', 'PERSONAL', amount);
    // The borrowed cash is still in hand on the last turn; the debt is not allowed to vanish.
    expect(g.balance('Asha')).toBe(START + amount);
    const r = g.endByVote('Asha');
    const result = finished(r);
    expect(result.standings).toEqual([
      { playerId: g.id('Bilal'), netWorth: START, liabilities: 0, rank: 1 },
      { playerId: g.id('Asha'), netWorth: START, liabilities: amount, rank: 2 },
    ]);
    expect(g.state.winnerId).toBe(g.id('Bilal'));
    sound(g);
  });
});

// ---------------------------------------------------------------------------
// Winner and tie-break
// ---------------------------------------------------------------------------

describe('the winner', () => {
  it('equal net worth: the lower total liabilities wins (a mortgage is a liability too)', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'INDORE');
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'INDORE' }); // +750 cash, 750 owed against it
    g.give('Bilal', 'AGRA');
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 1000 });
    const r = g.endByVote('Asha');
    expect(finished(r).standings).toEqual([
      { playerId: g.id('Bilal'), netWorth: START + 1500, liabilities: 0, rank: 1 },
      { playerId: g.id('Asha'), netWorth: START + 1500, liabilities: 750, rank: 2 },
      { playerId: g.id('Chitra'), netWorth: START + 1000, liabilities: 0, rank: 3 },
    ]);
    expect(finished(r)).toMatchObject({ winnerId: g.id('Bilal'), winnerIds: [g.id('Bilal')], sharedVictory: false });
    sound(g);
  });

  it('three players level on both: they share the victory; the fourth is fourth', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    for (const name of ['Asha', 'Bilal', 'Chitra']) g.act('Dev', { type: 'TRANSFER_MONEY', toPlayerId: g.id(name), amount: 1 });
    const r = g.endByVote('Asha');
    expect(finished(r).standings.map((s) => [s.playerId, s.rank])).toEqual([
      [g.id('Asha'), 1],
      [g.id('Bilal'), 1],
      [g.id('Chitra'), 1],
      [g.id('Dev'), 4],
    ]);
    expect(finished(r)).toMatchObject({ winnerId: null, sharedVictory: true, winnerIds: ['Asha', 'Bilal', 'Chitra'].map((n) => g.id(n)) });
    sound(g);
  });

  it('a bankrupt or departed player is never ranked, whatever is still recorded against their name', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    g.act('Dev', { type: 'LEAVE_GAME' });
    // Test surgery: a stale record that would top the table if it were ever counted.
    g.give('Dev', 'MUMBAI', { hotel: true });
    expect(netWorth(g.state, g.id('Dev'))).toBeGreaterThan(netWorth(g.state, g.id('Asha')));
    expect(rankStandings(g.state).map((s) => s.playerId)).not.toContain(g.id('Dev'));
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 1 });
    const r = g.endByVote('Asha');
    expect(finished(r).winnerIds).toEqual([g.id('Bilal')]);
    expect(finished(r).standings.map((s) => s.playerId)).not.toContain(g.id('Dev'));
  });

  it('the result is final: a finished game accepts nothing that could change it', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 1 });
    const r = g.endByVote('Asha');
    const snapshot = JSON.stringify(g.state);
    for (const action of [{ type: 'REQUEST_END_VOTE' }, { type: 'LEAVE_GAME' }, { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 5 }] as const) {
      expect(refusal(() => g.act('Bilal', action)).code).toBe('GAME_FINISHED');
    }
    expect(JSON.stringify(g.state)).toBe(snapshot);
    expect(r.events.filter((e) => e.type === 'GAME_FINISHED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Classic loans: maturity, overdue, default
// ---------------------------------------------------------------------------

describe('Classic loan maturity', () => {
  it('due at the maturity Start, overdue at the next, defaulted at the one after — each once; the debt stays owed, with no new interest', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    const loan = () => g.state.loans[0]!;
    expect(loan()).toMatchObject({ createdAtCircuit: 0, maturityCircuit: RULES.loans.maturityCircuits });
    const standing = () => classicLoanStanding(loan(), g.player('Asha').circuits);
    const laps = lapsOf(g, 'Asha', 6).map(types);
    expect(laps[0]).toEqual(expect.arrayContaining(['LOAN_INTEREST_DUE', 'LOAN_INTEREST_PAID']));
    expect(laps.map((t) => t.filter((x) => ['LOAN_PRINCIPAL_DUE', 'LOAN_OVERDUE', 'LOAN_DEFAULTED'].includes(x)))).toEqual([[], [], ['LOAN_PRINCIPAL_DUE'], ['LOAN_OVERDUE'], ['LOAN_DEFAULTED'], []]);
    expect(loan()).toMatchObject({ status: 'DEFAULTED', outstanding: 5000, closedAt: null, interestCharges: 1, interestPaid: 500 });
    expect(standing()).toBe('DEFAULTED');
    expect(balanceSheet(g.state, g.id('Asha')).loans).toBe(5000);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 })).message).toMatch(/in default/);
    // Repaying in parts; clearing it lifts the block.
    g.act('Asha', { type: 'REPAY_LOAN', loanId: loan().id, amount: 2000 });
    expect(loan()).toMatchObject({ status: 'DEFAULTED', outstanding: 3000 });
    g.act('Asha', { type: 'REPAY_LOAN', loanId: loan().id, amount: 3000 });
    expect(loan()).toMatchObject({ status: 'REPAID', outstanding: 0 });
    expect(classicBorrowingBlock(g.state, g.id('Asha'))).toBeNull();
    sound(g);
  });

  it('overdue already blocks new borrowing; repaying before the default checkpoint closes it cleanly', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    lapsOf(g, 'Asha', RULES.loans.maturityCircuits + RULES.loans.overdueAfterCircuits);
    expect(classicLoanStanding(g.state.loans[0]!, g.player('Asha').circuits)).toBe('OVERDUE');
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 })).message).toMatch(/overdue/);
    g.act('Asha', { type: 'REPAY_LOAN', loanId: g.state.loans[0]!.id, amount: 5000 });
    expect(g.state.loans[0]!.status).toBe('REPAID');
    expect(lapsOf(g, 'Asha', 2).flatMap(types)).not.toContain('LOAN_DEFAULTED');
  });

  it('a loan signed before loans had a maturity keeps its contract: it never falls due', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    g.state.loans[0]!.maturityCircuit = null; // stored before this rule existed
    const events = lapsOf(g, 'Asha', 6).flatMap(types);
    expect(events).not.toEqual(expect.arrayContaining(['LOAN_PRINCIPAL_DUE']));
    expect(g.state.loans[0]!.status).toBe('ACTIVE');
    expect(classicLoanStanding(g.state.loans[0]!, g.player('Asha').circuits)).toBe('CURRENT');
  });
});

// ---------------------------------------------------------------------------
// Credit score (Capital)
// ---------------------------------------------------------------------------

describe('credit score', () => {
  it('borrowing and prepaying at once, ten times over, earns nothing', () => {
    const g = capital();
    for (let i = 0; i < 10; i += 1) {
      const loan = borrow(g, 'Asha', 'EMERGENCY', 10000);
      g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: 10000 });
      expect(loanOf(g, loan.id).status).toBe('REPAID');
    }
    expect(scoreOf(g, 'Asha')).toBe(700);
    expect(eco(g).creditEvents).toEqual([]);
    expect(offeredRate('LONG_TERM', scoreOf(g, 'Asha')).ratePercent).toBe(10);
  });

  it('gains are capped at +10 a financial year, however many loans earn them; each event still counts only once', () => {
    const g = capital();
    const emergency = borrow(g, 'Asha', 'EMERGENCY', 10000);
    const personal = borrow(g, 'Asha', 'PERSONAL', 10000);
    jumpTo(g, YEAR); // Year 2: installment 1 of each is due
    const a = g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: emergency.id }); // +5 on time, then repaid with a good history: +10, of which +5 fits
    const b = g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: personal.id }); // +5 on time: nothing left this year
    expect(eco(g).creditEvents.map((e) => [e.type, e.loanId, e.year, e.delta])).toEqual([
      ['ON_TIME_PAYMENT', emergency.id, 2, 5],
      ['LOAN_REPAID', emergency.id, 2, 5],
      ['ON_TIME_PAYMENT', personal.id, 2, 0],
    ]);
    expect(scoreOf(g, 'Asha')).toBe(710);
    expect([...types(a), ...types(b)].filter((t) => t === 'CREDIT_SCORE_CHANGED')).toHaveLength(2);
    // Replaying the same checkpoints changes nothing.
    tick(g);
    tick(g);
    expect(eco(g).creditEvents).toHaveLength(3);
    // A new year, a new allowance. (Year 2 is not a clean year: installment 2 fell due at its very end, unpaid.)
    jumpTo(g, YEAR * 2);
    expect(eco(g).creditEvents.some((e) => e.type === 'CLEAN_YEAR')).toBe(false);
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: personal.id });
    expect(scoreOf(g, 'Asha')).toBe(715);
  });

  it('overdue −20, no credit for catching up, default −100 once — and the rate of the next loan follows the band', () => {
    const g = capital();
    const loan = borrow(g, 'Asha', 'EMERGENCY', 10000);
    jumpTo(g, YEAR + WINDOW + YEAR);
    expect(loanOf(g, loan.id).status).toBe('DEFAULTED');
    expect(eco(g).creditEvents.map((e) => [e.type, e.delta])).toEqual([
      ['INSTALLMENT_OVERDUE', -20],
      ['LOAN_DEFAULT', -100],
    ]);
    expect(scoreOf(g, 'Asha')).toBe(580);
    tick(g);
    tick(g);
    expect(eco(g).creditEvents.filter((e) => e.type === 'LOAN_DEFAULT')).toHaveLength(1);
    expect(loanOffers(g.state, g.id('Asha')).every((o) => o.blocked)).toBe(true);
    // Clearing the default reopens borrowing — at the Weak band's rate (+3 points). The score itself is not money.
    const worth = netWorth(g.state, g.id('Asha'));
    g.act('Asha', { type: 'PAY_DEFAULTED_LOAN', loanId: loan.id, amount: loanOf(g, loan.id).defaultBalance });
    expect(netWorth(g.state, g.id('Asha'))).toBe(worth);
    const emergency = loanOffers(g.state, g.id('Asha')).find((o) => o.product === 'EMERGENCY')!;
    expect(emergency).toMatchObject({ blocked: null, ratePercent: IR.loans.products.EMERGENCY.baseRatePercent + 3 });
  });
});

// ---------------------------------------------------------------------------
// Bankruptcy and the chance to raise funds
// ---------------------------------------------------------------------------

/** Asha, with ₹100, lands on Bilal's Delhi with two houses: ₹4,300 rent. */
function owingRent(names = ['Asha', 'Bilal', 'Chitra']) {
  const g = new TestGame(names);
  g.give('Bilal', 'DELHI', { houses: 2 });
  leaveWith(g, 'Asha', 100, 'Chitra');
  g.placeBefore('Asha', 'DELHI', 3);
  g.roll('Asha', 1, 2);
  expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT', amount: 4300, toPlayerId: g.id('Bilal') });
  return g;
}

describe('bankruptcy', () => {
  it('is refused while the bank would pay enough for what the player owns; mortgaging then pays the original rent to its owner', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI', { houses: 2 });
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeBefore('Asha', 'DELHI', 3);
    g.roll('Asha', 1, 2);
    expect(bankruptcyBlocker(g.state, g.id('Asha'), 4300)).toBe(
      'You can still raise the ₹4,300: mortgage a property, sell a property to the bank. Bankruptcy is only possible when even that would not be enough.',
    );
    expect(refusal(() => g.act('Asha', { type: 'DECLARE_BANKRUPTCY' })).code).toBe('INVALID_PHASE');
    expect(refusal(() => g.act('Asha', { type: 'PAY_RENT' })).code).toBe('INSUFFICIENT_FUNDS');
    // The payment waits, unchanged, while she raises the money.
    expect(g.state.turn.pending).toMatchObject({ reason: 'RENT', amount: 4300, toPlayerId: g.id('Bilal') });
    const bilal = g.balance('Bilal');
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    const paid = g.act('Asha', { type: 'PAY_RENT' });
    expect(paid.transactions.map((t) => [t.type, t.toPlayerId, t.amount])).toEqual([['RENT_PAYMENT', g.id('Bilal'), 4300]]);
    expect(g.balance('Bilal')).toBe(bilal + 4300);
    expect(g.balance('Asha')).toBe(100 + 4250 - 4300);
    sound(g);
  });

  it('selling a building raises half its cost; the player chooses what to sell and stops once the payment is covered', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI', { houses: 2 });
    g.give('Asha', 'INDORE');
    g.give('Bilal', 'DELHI', { houses: 2 });
    leaveWith(g, 'Asha', 1000, 'Chitra');
    g.placeBefore('Asha', 'DELHI', 3);
    g.roll('Asha', 1, 2);
    const r = g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['HOUSE_SALE', 3750]]);
    g.act('Asha', { type: 'PAY_RENT' });
    // Everything else is still hers.
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), houses: 1 });
    expect(g.state.properties.INDORE.ownerId).toBe(g.id('Asha'));
    sound(g);
  });

  it('borrowing is offered but never required: with nothing left to sell, bankruptcy is allowed even when a loan is available', () => {
    const g = owingRent();
    expect(raiseFundsOptions(g.state, g.id('Asha'))).toEqual(['take a loan (optional)']);
    expect(bankruptcyBlocker(g.state, g.id('Asha'), 4300)).toBeNull();
    // She may borrow and pay…
    const other = owingRent();
    other.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
    other.act('Asha', { type: 'PAY_RENT' });
    expect(other.player('Asha').status).toBe('ACTIVE');
    // …or go bankrupt instead: her cash goes to the rent's owner.
    const bilal = g.balance('Bilal');
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.transactions.map((t) => [t.type, t.toPlayerId, t.amount])).toEqual([['BANKRUPTCY_SETTLEMENT', g.id('Bilal'), 100]]);
    expect(g.balance('Bilal')).toBe(bilal + 100);
    expect(r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload).toMatchObject({ unpaid: 4200, claims: [{ kind: 'PAYMENT', owed: 4300, paid: 100, unpaid: 4200, creditorIds: [g.id('Bilal')] }] });
    sound(g);
  });

  it('the estate raises what the player could have and pays the creditor first; nothing is left in the bankrupt player’s name', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'INDORE', { houses: 1 });
    g.give('Asha', 'PATNA', { mortgaged: true });
    g.give('Bilal', 'MUMBAI', { hotel: true });
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5); // passes Start: +1,500
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['HOUSE_SALE', 1000],
      ['PROPERTY_SALE', getDeed('INDORE').mortgageValue],
      ['BANKRUPTCY_SETTLEMENT', 1600 + 1000 + 750],
    ]);
    // Patna was already mortgaged: it raises nothing more and goes back to the bank cleared, with Indore.
    expect(g.state.properties.PATNA).toEqual({ key: 'PATNA', ownerId: null, houses: 0, hotel: false, mortgaged: false });
    expect(g.state.properties.INDORE).toEqual({ key: 'INDORE', ownerId: null, houses: 0, hotel: false, mortgaged: false });
    expect(g.player('Asha')).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    // It happens once.
    expect(refusal(() => g.act('Asha', { type: 'DECLARE_BANKRUPTCY' })).code).toBe('FORBIDDEN');
    // The bank's property is for sale again in the ordinary way.
    g.placeBefore('Bilal', 'INDORE', 5);
    g.rollTotal('Bilal', 5);
    expect(g.state.turn.pending).toMatchObject({ kind: 'BUY', propertyKey: 'INDORE', price: getDeed('INDORE').price });
    sound(g);
  });

  it('a payment owed to several players is shared equally; odd rupees go one each in turn order', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    leaveWith(g, 'Asha', 101, 'Bilal');
    g.landOn('Asha', positionOfSpecial('CLUB'), 5);
    expect(g.state.turn.pending).toMatchObject({ reason: 'CLUB', amount: 300 });
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.transactions.map((t) => [t.type, t.toPlayerId, t.amount])).toEqual([
      ['BANKRUPTCY_SETTLEMENT', g.id('Bilal'), 34],
      ['BANKRUPTCY_SETTLEMENT', g.id('Chitra'), 34],
      ['BANKRUPTCY_SETTLEMENT', g.id('Dev'), 33],
    ]);
    sound(g);
  });

  it('a pledged property raises nothing while pledged, but in a bankruptcy it is recovered for its own loan and the surplus pays the creditor', () => {
    const g = capital(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'DELHI');
    g.give('Asha', 'MADRAS');
    g.give('Bilal', 'MUMBAI', { hotel: true });
    const loan = borrow(g, 'Asha', 'SECURED', 10000, ['DELHI', 'MADRAS']);
    expect(propertyLiquidationValue(g.state, 'DELHI')).toBe(0);
    expect(propertyLiquidationValue(g.state, 'MADRAS')).toBe(0);
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeBefore('Asha', 'MUMBAI', 5);
    g.rollTotal('Asha', 5);
    const cash = g.balance('Asha');
    const bilal = g.balance('Bilal');
    // What closes the loan now: its principal and the interest accrued over the spaces moved since signing.
    const payoff = 10000 + accruedInterest(10000, loan.ratePercent, gameClock(eco(g)) - loan.originClock, 108);
    expect(payoff).toBeGreaterThan(10000);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    const value = eco(g).market.DELHI.value + eco(g).market.MADRAS.value;
    expect(loanOf(g, loan.id)).toMatchObject({ status: 'SETTLED', collateralKeys: [], settlement: { propertyKeys: ['DELHI', 'MADRAS'], value, applied: payoff, surplus: value - payoff } });
    expect(g.balance('Bilal')).toBe(bilal + cash + value - payoff);
    sound(g);
  });
});

// ---------------------------------------------------------------------------
// Gifts and trades while a payment is owed
// ---------------------------------------------------------------------------

describe('gifts and trades while a payment is owed', () => {
  it('the debtor cannot give money away; anyone may give money to the debtor; ordinary gifts are untouched', () => {
    const g = owingRent();
    expect(mandatoryPaymentsOwed(g.state, g.id('Asha'))).toBe(4300);
    expect(refusal(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 50 }))).toEqual({
      code: 'TRANSFER_NOT_ALLOWED',
      message: 'Settle the payment you owe before giving money away.',
    });
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 4300 });
    g.act('Asha', { type: 'PAY_RENT' });
    expect(mandatoryPaymentsOwed(g.state, g.id('Asha'))).toBe(0);
    g.act('Asha', { type: 'END_TURN' });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 100 });
    sound(g);
  });

  it('a crisis bill counts the same: its owner can’t give money away before settling it', () => {
    const g = capital();
    eco(g).insurance!.crises.push({
      id: 'crisis-1', checkpoint: 99, checkpointClock: 0, year: 1, propertyKey: null, ownerId: g.id('Asha'), mortgaged: false,
      amount: 3000, paid: 0, policyId: null, status: 'PENDING', createdAt: g.ctx().now, settledAt: null,
    });
    expect(mandatoryPaymentsOwed(g.state, g.id('Asha'))).toBe(3000);
    const before = JSON.stringify(g.state);
    expect(() => g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 })).toThrow();
    expect(JSON.stringify(g.state)).toBe(before);
  });

  it('a trade can’t strip the debtor: a property for a token sum is refused, the same property for what the bank would pay goes through', () => {
    const g = owingRent();
    g.give('Asha', 'MUMBAI');
    const strip: GameAction = { type: 'CREATE_TRADE', toPlayerId: g.id('Chitra'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 };
    expect(refusal(() => g.act('Asha', strip)).message).toBe('Asha has a payment to settle: a trade can’t leave them with less than the bank would pay for what they give up.');
    // The other side can't ask for it either.
    expect(refusal(() => g.act('Chitra', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: [], requestedPropertyKeys: ['MUMBAI'], offeredMoney: 100, requestedMoney: 0 })).code).toBe('TRADE_NOT_ALLOWED');
    // A fair sale — at or above Mumbai's mortgage value — is allowed, and the cash is genuine consideration.
    g.act('Asha', { ...strip, requestedMoney: 5000 } as GameAction);
    g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: g.state.trades.at(-1)!.id });
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Chitra'));
    g.act('Asha', { type: 'PAY_RENT' });
    expect(g.balance('Asha')).toBe(100 + 5000 - 4300);
    sound(g);
  });

  it('an offer made before the debt is judged again when accepted; ordinary trades keep their freedom', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'AGRA');
    g.give('Bilal', 'DELHI', { houses: 2 });
    // With nothing owed, giving a property away for ₹1 is the players' own business.
    g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Chitra'), offeredPropertyKeys: ['AGRA'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 1 });
    g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: g.state.trades.at(-1)!.id });
    expect(g.state.properties.AGRA.ownerId).toBe(g.id('Chitra'));
    g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Chitra'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 1 });
    const offer = g.state.trades.at(-1)!.id;
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeBefore('Asha', 'DELHI', 3);
    g.roll('Asha', 1, 2);
    expect(refusal(() => g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: offer })).message).toMatch(/^Trade can't go through: Asha has a payment to settle/);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
  });

  it('money players lend each other is not a game debt: a gift is never collected back', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 5000, memo: 'Loan — pay me back' });
    expect(g.state.loans).toEqual([]);
    expect(netWorth(g.state, g.id('Bilal'))).toBe(START - 5000);
    const bilal = g.balance('Bilal');
    const r = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(g.balance('Bilal')).toBe(bilal);
    expect(r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload).toMatchObject({ creditorIds: [], claims: [] });
  });
});

// ---------------------------------------------------------------------------
// Leaving, and not leaving
// ---------------------------------------------------------------------------

describe('leaving the game', () => {
  it('owing the bank more than the cash: the estate sells what it must, pays the loan, and records the rest as unpaid', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'INDORE', { houses: 1 });
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 });
    leaveWith(g, 'Asha', 1000, 'Bilal');
    const r = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['HOUSE_SALE', 1000],
      ['PROPERTY_SALE', 750],
      ['LOAN_REPAYMENT', 2750],
    ]);
    expect(g.state.loans[0]).toMatchObject({ status: 'DEFAULTED', outstanding: 20000 - 2750, closedAt: expect.any(String) });
    expect(r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload).toMatchObject({ kind: 'DEPARTURE', liquidation: 1750, residual: 0, unpaid: 20000 - 2750 });
    expect(g.player('Asha')).toMatchObject({ status: 'LEFT', balance: 0 });
    // Not a bankruptcy, and nothing is collectable from a player who is gone.
    expect(types(r)).not.toContain('PLAYER_BANKRUPT');
    expect(balanceSheet(g.state, g.id('Asha')).loans).toBe(0);
    sound(g);
  });

  it('Capital: a secured loan takes its collateral, an unsecured one is repaid from cash, the rest leaves play', () => {
    const g = capital(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'DELHI');
    g.give('Asha', 'MADRAS');
    const secured = borrow(g, 'Asha', 'SECURED', 10000, ['DELHI', 'MADRAS']);
    const personal = borrow(g, 'Asha', 'PERSONAL', 10000);
    const value = eco(g).market.DELHI.value + eco(g).market.MADRAS.value;
    const r = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['COLLATERAL_SURPLUS', value - 10000],
      ['LOAN_REPAYMENT', 10000],
      ['ESTATE_SETTLEMENT', START + 10000 + value - 10000],
    ]);
    expect(loanOf(g, secured.id)).toMatchObject({ status: 'SETTLED', settlement: { propertyKeys: ['DELHI', 'MADRAS'], applied: 10000 } });
    expect(loanOf(g, personal.id)).toMatchObject({ status: 'SETTLED' });
    expect(g.state.properties.DELHI.ownerId).toBeNull();
    expect(g.state.properties.MADRAS.ownerId).toBeNull();
    sound(g);
  });

  it('a player who is offline is never removed by anyone else: the game has no remove after the start, and no timeout of its own', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    lap(g); // Asha's turn done; Bilal's turn now — and Bilal has gone quiet.
    expect(g.current).toBe('Bilal');
    expect(refusal(() => g.act('Asha', { type: 'REMOVE_PLAYER', playerId: g.id('Bilal') })).code).toBe('INVALID_PHASE');
    expect(refusal(() => g.act('Chitra', { type: 'ROLL_DICE' })).code).toBe('NOT_YOUR_TURN');
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 10 });
    expect(g.player('Bilal')).toMatchObject({ status: 'ACTIVE', balance: START });
    // When Bilal is back, the turn is still his.
    lap(g);
    expect(g.current).toBe('Chitra');
  });
});

// ---------------------------------------------------------------------------
// Credit score: early repayment stays legitimate
// ---------------------------------------------------------------------------

describe('credit score — repaying early, and repaying late', () => {
  it('an installment paid on time, then the rest prepaid: allowed, and the full-repayment bonus is earned once (within the yearly cap)', () => {
    const g = capital();
    const loan = borrow(g, 'Asha', 'PERSONAL', 10000);
    jumpTo(g, YEAR);
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    const rest = loanOf(g, loan.id).installments.filter((i) => i.status === 'SCHEDULED').reduce((sum, i) => sum + i.principal, 0);
    expect(rest).toBeGreaterThan(0);
    g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: rest });
    expect(loanOf(g, loan.id).status).toBe('REPAID');
    expect(eco(g).creditEvents.map((e) => [e.type, e.delta])).toEqual([
      ['ON_TIME_PAYMENT', 5],
      ['LOAN_REPAID', 5],
    ]);
    expect(eco(g).creditEvents[1]!.reason).toContain('yearly limit');
    expect(scoreOf(g, 'Asha')).toBe(710);
    // Nothing is left to repay, so the bonus can't be earned again.
    expect(refusal(() => g.act('Asha', { type: 'PREPAY_INTERMEDIATE_LOAN', loanId: loan.id, amount: 1000 })).code).toBe('LOAN_NOT_ALLOWED');
    expect(refusal(() => g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id })).code).toBe('LOAN_NOT_ALLOWED');
    tick(g);
    expect(eco(g).creditEvents.filter((e) => e.type === 'LOAN_REPAID')).toHaveLength(1);
  });

  it('a loan caught up after going overdue is repaid, but earns neither a catch-up nor a full-repayment bonus', () => {
    const g = capital();
    const loan = borrow(g, 'Asha', 'EMERGENCY', 10000);
    jumpTo(g, YEAR + WINDOW);
    expect(loanOf(g, loan.id).installments[0]!.status).toBe('OVERDUE');
    expect(loanOffers(g.state, g.id('Asha')).every((o) => o.blocked)).toBe(true);
    g.act('Asha', { type: 'PAY_LOAN_INSTALLMENT', loanId: loan.id });
    expect(loanOf(g, loan.id).status).toBe('REPAID');
    expect(eco(g).creditEvents.map((e) => [e.type, e.delta])).toEqual([['INSTALLMENT_OVERDUE', -20]]);
    expect(scoreOf(g, 'Asha')).toBe(680);
    // Paid up: borrowing is open again, at the band the score is now in (Fair: no adjustment).
    expect(loanOffers(g.state, g.id('Asha')).find((o) => o.product === 'EMERGENCY')).toMatchObject({ blocked: null, ratePercent: IR.loans.products.EMERGENCY.baseRatePercent });
  });
});

// ---------------------------------------------------------------------------
// Insolvency on each kind of mandatory payment
// ---------------------------------------------------------------------------

describe('insolvency on each mandatory payment', () => {
  it('Income Tax: with nothing left to raise, the cash goes to the bank, the rest is recorded unpaid, and the property returns clean', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'PATNA', { mortgaged: true });
    g.give('Asha', 'AGRA', { mortgaged: true });
    leaveWith(g, 'Asha', 50, 'Chitra');
    g.landOn('Asha', positionOfSpecial('INCOME_TAX'), 5);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'TAX', amount: 100, toPlayerId: null });
    expect(bankruptcyBlocker(g.state, g.id('Asha'), 100)).toBeNull();
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.transactions.map((t) => [t.type, t.toPlayerId, t.amount])).toEqual([['BANKRUPTCY_SETTLEMENT', null, 50]]);
    expect(r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload).toMatchObject({ kind: 'BANKRUPTCY', unpaid: 50, claims: [{ kind: 'PAYMENT', owed: 100, paid: 50, unpaid: 50, creditorIds: [] }], propertiesReturned: ['AGRA', 'PATNA'].sort((a, b) => PROPERTY_KEYS.indexOf(a as PropertyKey) - PROPERTY_KEYS.indexOf(b as PropertyKey)) });
    for (const key of ['PATNA', 'AGRA'] as const) expect(g.state.properties[key]).toMatchObject({ ownerId: null, mortgaged: false, houses: 0, hotel: false });
    expect(g.player('Asha')).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    expect(g.current).toBe('Bilal');
    sound(g);
  });

  it('a Chance charge: refused while a building could still raise it, then paid to the bank as charged', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI', { houses: 1 });
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.landOn('Asha', 20, 8);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'CARD', amount: 3000, toPlayerId: null });
    expect(refusal(() => g.act('Asha', { type: 'DECLARE_BANKRUPTCY' })).code).toBe('INVALID_PHASE');
    g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    const r = g.act('Asha', { type: 'PAY_CARD' });
    expect(r.transactions.map((t) => [t.type, t.toPlayerId, t.amount])).toEqual([['CARD_PAYMENT', null, 3000]]);
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    sound(g);
  });

  it('a Chance charge with nothing left to raise: the cash is settled once to the bank, the rest recorded unpaid', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.landOn('Asha', 20, 8);
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.transactions.map((t) => [t.type, t.toPlayerId, t.amount])).toEqual([['BANKRUPTCY_SETTLEMENT', null, 100]]);
    expect(r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload).toMatchObject({ unpaid: 2900, claims: [{ kind: 'PAYMENT', owed: 3000, paid: 100, unpaid: 2900 }] });
    expect(refusal(() => g.act('Asha', { type: 'DECLARE_BANKRUPTCY' })).code).toBe('FORBIDDEN');
    sound(g);
  });

  it('Classic loan interest at Start: the interest is paid first; what it could not cover is recorded once, not again on the loan', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 });
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeAt('Asha', BOARD_SIZE - 2);
    g.roll('Asha', 1, 1);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'LOAN_INTEREST', amount: 2000 });
    expect(g.balance('Asha')).toBe(100 + RULES.start.passReward);
    const r = g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['LOAN_INTEREST', 1600]]);
    const settled = r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload as { unpaid: number; claims: { kind: string; owed: number; paid: number; unpaid: number }[] };
    expect(settled.claims.map((c) => [c.kind, c.owed, c.paid, c.unpaid])).toEqual([
      ['PAYMENT', 2000, 1600, 400],
      ['LOAN', 20000, 0, 20000],
    ]);
    expect(settled.unpaid).toBe(20400);
    expect(g.state.loans[0]).toMatchObject({ status: 'DEFAULTED', outstanding: 20000, interestPaid: 1600, closedAt: expect.any(String) });
    sound(g);
  });

  it('the bankrupt player is out of every active effect: no turn, no trade, no vote, no rent', () => {
    const g = owingRent();
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.current).toBe('Bilal');
    expect(refusal(() => g.act('Asha', { type: 'ROLL_DICE' })).code).toBe('FORBIDDEN');
    expect(refusal(() => g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: ['DELHI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 0 })).code).toBe('TRADE_NOT_ALLOWED');
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_END_VOTE' })).code).toBe('FORBIDDEN');
    expect(rankStandings(g.state).map((s) => s.playerId)).not.toContain(g.id('Asha'));
  });
});

// ---------------------------------------------------------------------------
// Resale auctions while a payment is owed (Capital)
// ---------------------------------------------------------------------------

describe('resale auctions while a payment is owed', () => {
  function owingRentCapital() {
    const g = capital(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI', { houses: 2 });
    leaveWith(g, 'Asha', 100, 'Chitra');
    g.placeBefore('Asha', 'DELHI', 3);
    g.roll('Asha', 1, 2);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'RENT', toPlayerId: g.id('Bilal') });
    return g;
  }

  it('the debtor may auction to raise the money, but not for a token reserve: at least what the bank would pay', () => {
    const g = owingRentCapital();
    const floor = propertyLiquidationValue(g.state, 'MUMBAI');
    expect(floor).toBeGreaterThan(100);
    expect(refusal(() => g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 100 }))).toEqual({
      code: 'VALIDATION',
      message: `You have a payment to settle: the reserve must be at least ${formatINR(floor)}, what the bank would pay for this property.`,
    });
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: floor });
    expect(g.state.auction).toMatchObject({ propertyKey: 'MUMBAI', resale: { sellerId: g.id('Asha'), reservePrice: floor } });
    // The rent is still owed, unchanged.
    expect(mandatoryPaymentsOwed(g.state, g.id('Asha'))).toBeGreaterThan(0);
  });

  it('with nothing owed, the seller sets any reserve they like', () => {
    const g = capital(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 100 });
    expect(g.state.auction).toMatchObject({ resale: { reservePrice: 100 } });
  });
});
