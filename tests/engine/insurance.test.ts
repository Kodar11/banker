import { describe, expect, it } from 'vitest';
import {
  activePolicyFor,
  averageSpaces,
  BOARD_SIZE,
  claimPayout,
  getDeed,
  crisisBankruptcyBlocker,
  crisisCheckpointClock,
  crisisDue,
  crisisRecoveryOptions,
  financialOverview,
  gameClock,
  GameError,
  INTERMEDIATE_RULES,
  insuranceQuote,
  insureAllBlocker,
  insureBlocker,
  isCoveredCrisis,
  loyaltyPercent,
  netWorth,
  noClaimPercent,
  offeredRate,
  pendingCrises,
  pendingCrisisOf,
  policyStanding,
  portfolioPercent,
  premiumForYear,
  PROPERTY_KEYS,
  propertyInsurance,
  remainingCover,
  renewalBlocker,
  renewalNoClaimPeriods,
  renewalOffer,
  renewalWindow,
  uninsuredProperties,
  unmortgageCost,
  upgradeInsurance,
  yearAt,
  type EngineResult,
  type GameAction,
  type InsurancePolicy,
  type InsuranceState,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';
import { stateViolations } from './invariantChecks.ts';

const INS = INTERMEDIATE_RULES.insurance;
const START_CASH = 25000;
const START_REWARD = 1500;
const BILL = 3000;
/** The Year 1 premium for one property. */
const P1 = 250;
/** Two starting players: 36 spaces of average movement = 72 on the shared clock; the first crisis is at 36. */
const COVER = 72;
const FIRST = 36;
const SECOND = 108;
const THIRD = 180;
const FOURTH = 252;

const newGame = (names = ['Asha', 'Bilal']) => new TestGame(names, { mode: 'intermediate' });
const eco = (g: TestGame): IntermediateState => g.state.intermediate!;
const ins = (g: TestGame): InsuranceState => eco(g).insurance!;
const types = (r: EngineResult) => r.events.map((e) => e.type);
const crisisAt = (g: TestGame, checkpoint: number) => ins(g).crises.find((c) => c.checkpoint === checkpoint)!;
const nameOf = (g: TestGame, id: string | null) => Object.keys(g.ids).find((n) => g.ids[n] === id)!;
const policy = (g: TestGame, id: string) => ins(g).policies.find((p) => p.id === id)!;

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GameError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

/** Puts the shared clock at `value` and the calendar with it (test surgery). The crisis schedule is left alone. */
function setClock(g: TestGame, value: number) {
  const e = eco(g);
  const ids = Object.keys(e.movement);
  for (const id of ids) e.movement[id] = 0;
  e.movement[ids[0]!] = value;
  e.year = yearAt(e, value);
}

/** Marks every checkpoint up to `clock` as already processed, for tests that are about a later one. */
function scheduleFrom(g: TestGame, clock: number) {
  while (crisisCheckpointClock(eco(g), ins(g).nextCheckpoint) <= clock) ins(g).nextCheckpoint += 1;
}

function eligibleKeys(g: TestGame): PropertyKey[] {
  const playing = new Set(g.state.players.filter((p) => p.status === 'ACTIVE').map((p) => p.id));
  return PROPERTY_KEYS.filter((k) => {
    const owner = g.state.properties[k].ownerId;
    return owner !== null && playing.has(owner);
  });
}

/**
 * The current player rolls 1+2 from three squares before Start (so nothing is left to resolve),
 * taking the shared clock from `target − 3` to `target`. `pick` is the property the server's draw
 * lands on when more than one is eligible.
 */
function rollTo(g: TestGame, target: number, pick?: PropertyKey): EngineResult {
  setClock(g, target - 3);
  const name = g.current;
  g.placeAt(name, BOARD_SIZE - 3);
  const eligible = eligibleKeys(g);
  const draw = pick && eligible.length > 1 ? [(eligible.indexOf(pick) + 0.5) / eligible.length] : [];
  g.queueRandom(faceToRandom(1), faceToRandom(2), ...draw);
  const result = g.act(name, { type: 'ROLL_DICE' });
  expect(gameClock(eco(g))).toBe(target);
  return result;
}

/** Ends the turn if it is over, rolls to `target`, and has every crisis bill that brought paid by its owner. */
function advance(g: TestGame, target: number, pick?: PropertyKey): EngineResult {
  if (g.state.turn.phase === 'TURN_COMPLETE') g.act(g.current, { type: 'END_TURN' });
  const result = rollTo(g, target, pick);
  for (const c of pendingCrises(g.state)) pay(g, nameOf(g, c.ownerId), c.id);
  return result;
}

const insure = (g: TestGame, name: string, propertyKey: PropertyKey) =>
  g.act(name, { type: 'INSURE_PROPERTY', propertyKey, expectedPremium: insuranceQuote({ year: eco(g).year, properties: 1 }).premium });

const insureAll = (g: TestGame, name: string, propertyKeys: PropertyKey[], expectedPremium = insuranceQuote({ year: eco(g).year, properties: propertyKeys.length }).premium) =>
  g.act(name, { type: 'INSURE_PROPERTIES', propertyKeys, expectedPremium });

const renew = (g: TestGame, name: string, policyId: string, expectedPremium = renewalOffer(g.state, policy(g, policyId))!.pricing.premium) =>
  g.act(name, { type: 'RENEW_INSURANCE', policyId, expectedPremium });

const pay = (g: TestGame, name: string, crisisId = pendingCrisisOf(g.state, g.id(name))!.id) => g.act(name, { type: 'PAY_CRISIS_BILL', crisisId });

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number, collateralKeys?: PropertyKey[]) {
  const expectedRatePercent = offeredRate(product, eco(g).credit[g.id(name)]!).ratePercent;
  g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKeys ? { collateralKeys } : {}) });
}

/** Leaves `name` with exactly `keep` in cash by paying the rest to another player (through the ledger). */
function leaveWith(g: TestGame, name: string, keep: number, to: string) {
  const amount = g.balance(name) - keep;
  if (amount > 0) g.act(name, { type: 'TRANSFER_MONEY', toPlayerId: g.id(to), amount });
}

/** `from` gives `keys` to `to` for nothing through an accepted trade. */
function tradeAway(g: TestGame, from: string, to: string, keys: PropertyKey[]): EngineResult {
  g.act(from, { type: 'CREATE_TRADE', toPlayerId: g.id(to), offeredPropertyKeys: keys, requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 1 });
  const tradeId = g.state.trades.find((t) => t.status === 'PENDING')!.id;
  return g.act(to, { type: 'ACCEPT_TRADE', tradeId });
}

// ---------------------------------------------------------------------------

describe('premium pricing', () => {
  it('₹250 in Year 1, +₹50 a year, capped at ₹450: early buyers pay less', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(premiumForYear)).toEqual([250, 300, 350, 400, 450, 450, 450]);
    expect(INS).toMatchObject({ premiumYear1: 250, premiumStepPerYear: 50, premiumMax: 450, coverageSpaces: 36, crisisBill: 3000, firstCrisisSpaces: 18, crisisIntervalSpaces: 36 });
    expect(INS).toMatchObject({ payoutLimit: 3000, deductible: 0, coveredCrises: ['PROPERTY_CRISIS'] });
  });

  it('the payout limit pays every crisis one coverage period can bring in full', () => {
    // A 36-space period always holds exactly one checkpoint (one every 36), and a crisis strikes one property.
    for (const players of [2, 3, 4]) {
      const e = { playerCount: players };
      for (const start of [0, 1, 17, 35, 36, 50, 100]) {
        const p = { startClock: start * players, expiryClock: (start + INS.coverageSpaces) * players };
        const inside = [1, 2, 3, 4, 5].map((n) => crisisCheckpointClock(e, n)).filter((c) => c >= p.startClock && c < p.expiryClock);
        expect(inside).toHaveLength(1);
      }
    }
    expect(INS.payoutLimit).toBe(INS.crisisBill - INS.deductible);
  });

  it('portfolio discount: 5% for each property after the first, up to 25%', () => {
    expect([1, 2, 3, 4, 5, 6, 8, 26].map(portfolioPercent)).toEqual([0, 5, 10, 15, 20, 25, 25, 25]);
    expect(insuranceQuote({ year: 1, properties: 3 })).toEqual({
      basePremium: 250,
      properties: 3,
      grossPremium: 750,
      portfolioPercent: 10,
      loyaltyPercent: 0,
      noClaimPercent: 0,
      discountPercent: 10,
      premium: 675,
    });
  });

  it('a portfolio always costs less than separate policies, and never close to nothing', () => {
    for (const year of [1, 3, 6]) {
      for (let n = 2; n <= 26; n += 1) {
        const portfolio = insuranceQuote({ year, properties: n }).premium;
        expect(portfolio).toBeLessThan(n * insuranceQuote({ year, properties: 1 }).premium);
        expect(portfolio).toBeGreaterThanOrEqual(Math.round(n * premiumForYear(year) * 0.75));
      }
    }
  });

  it('early-buyer loyalty: 20% for a line first bought in Year 1, 10% in Year 2, none later — on renewals only', () => {
    expect([1, 2, 3, 7].map(loyaltyPercent)).toEqual([20, 10, 0, 0]);
    expect(insuranceQuote({ year: 3, properties: 1 }).loyaltyPercent).toBe(0);
    expect(insuranceQuote({ year: 3, properties: 1, renewal: { entryYear: 1, noClaimPeriods: 0 } })).toMatchObject({ loyaltyPercent: 20, premium: 280 });
    expect(insuranceQuote({ year: 3, properties: 1, renewal: { entryYear: 2, noClaimPeriods: 0 } })).toMatchObject({ loyaltyPercent: 10, premium: 315 });
    expect(insuranceQuote({ year: 3, properties: 1, renewal: { entryYear: 3, noClaimPeriods: 0 } })).toMatchObject({ loyaltyPercent: 0, premium: 350 });
  });

  it('no-claim discount: 10% per claim-free period in a row, up to 30%', () => {
    expect([0, 1, 2, 3, 4, 9].map(noClaimPercent)).toEqual([0, 10, 20, 30, 30, 30]);
    expect(renewalNoClaimPeriods({ claimedTotal: 0, noClaimPeriods: 0 })).toBe(1);
    expect(renewalNoClaimPeriods({ claimedTotal: 0, noClaimPeriods: 2 })).toBe(3);
    expect(renewalNoClaimPeriods({ claimedTotal: 0, noClaimPeriods: 3 })).toBe(3);
    // One claim or several: the run starts again, once.
    expect(renewalNoClaimPeriods({ claimedTotal: 3000, noClaimPeriods: 3 })).toBe(0);
    expect(renewalNoClaimPeriods({ claimedTotal: 6000, noClaimPeriods: 3 })).toBe(0);
  });

  it('discounts add up and are capped at 50% together', () => {
    // 3 + 20 + 30 = 53 → 50.
    expect(insuranceQuote({ year: 5, properties: 6, renewal: { entryYear: 1, noClaimPeriods: 3 } })).toMatchObject({
      grossPremium: 2700,
      portfolioPercent: 25,
      loyaltyPercent: 20,
      noClaimPercent: 30,
      discountPercent: 50,
      premium: 1350,
    });
    expect(insuranceQuote({ year: 4, properties: 3, renewal: { entryYear: 1, noClaimPeriods: 1 } })).toMatchObject({ discountPercent: 40, premium: 720 });
    // Whole rupees.
    expect(Number.isInteger(insuranceQuote({ year: 2, properties: 7 }).premium)).toBe(true);
  });

  it('a purchase is charged once, at the quote of the financial year it is bought in', () => {
    const g = newGame();
    for (const key of ['MUMBAI', 'DELHI', 'AGRA'] as const) g.give('Asha', key);
    const first = insure(g, 'Asha', 'MUMBAI');
    expect(first.transactions).toMatchObject([{ type: 'INSURANCE_PREMIUM', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: P1, propertyKey: 'MUMBAI' }]);
    expect(ins(g).policies[0]).toMatchObject({ propertyKeys: ['MUMBAI'], premiumPaid: P1, purchaseYear: 1, entryYear: 1, payoutLimit: 3000, claimedTotal: 0, renewalOf: null });
    // A later newcomer pays the later year's price.
    setClock(g, 3 * COVER + 10);
    scheduleFrom(g, gameClock(eco(g)));
    expect(eco(g).year).toBe(4);
    insure(g, 'Asha', 'DELHI');
    expect(ins(g).policies[1]).toMatchObject({ premiumPaid: 400, purchaseYear: 4, entryYear: 4 });
    expect(g.balance('Asha')).toBe(START_CASH - P1 - 400);
  });

  it('the server sets the price: a confirmation for another price is refused and nothing is charged', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    const r = refusal(() => g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 100 }));
    expect(r.code).toBe('STALE_STATE');
    expect(r.message).toContain('₹250');
    expect(g.balance('Asha')).toBe(START_CASH);
    expect(ins(g).policies).toEqual([]);
  });

  it('without the cash the purchase is refused: no deduction, no policy, no debt', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    leaveWith(g, 'Asha', P1 - 1, 'Bilal');
    expect(insureBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBe('Not enough money — the premium is ₹250.');
    expect(refusal(() => insure(g, 'Asha', 'MUMBAI')).code).toBe('INSUFFICIENT_FUNDS');
    expect(g.balance('Asha')).toBe(P1 - 1);
    expect(ins(g).policies).toEqual([]);
    expect(eco(g).loans).toEqual([]);
  });

  it('only the owner can insure, and a property is insured once at a time', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    expect(refusal(() => insure(g, 'Bilal', 'MUMBAI')).code).toBe('NOT_OWNER');
    expect(refusal(() => insure(g, 'Asha', 'DELHI')).code).toBe('NOT_OWNER');
    insure(g, 'Asha', 'MUMBAI');
    const again = refusal(() => insure(g, 'Asha', 'MUMBAI'));
    expect(again.code).toBe('INSURANCE_NOT_ALLOWED');
    expect(again.message).toContain('Already insured');
    expect(g.balance('Asha')).toBe(START_CASH - P1);
    expect(ins(g).policies).toHaveLength(1);
  });

  it('a crisis never changes the price of a policy already bought, or of a new one', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI');
    insure(g, 'Asha', 'MUMBAI');
    const quote = insuranceQuote({ year: 1, properties: 1 });
    rollTo(g, FIRST, 'DELHI');
    expect(crisisAt(g, 1)).toMatchObject({ propertyKey: 'DELHI', status: 'PENDING' });
    expect(ins(g).policies[0]!.premiumPaid).toBe(P1);
    pay(g, 'Asha');
    expect(propertyInsurance(g.state, 'DELHI')!.premium).toBe(quote.premium);
  });
});

describe('policy duration', () => {
  it('starts at once and runs for 36 spaces of average movement from the purchase point', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    setClock(g, 10);
    insure(g, 'Asha', 'MUMBAI');
    const p = ins(g).policies[0]!;
    expect(policy(g, p.id)).toMatchObject({ ownerId: g.id('Asha'), propertyKeys: ['MUMBAI'], startClock: 10, expiryClock: 10 + COVER, status: 'ACTIVE' });
    expect(activePolicyFor(g.state, 'MUMBAI')?.id).toBe(p.id);
    expect(averageSpaces(eco(g), p.expiryClock) - averageSpaces(eco(g), p.startClock)).toBe(36);
  });

  it('with three starting players 36 average spaces are 108 on the shared clock', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    expect(ins(g).policies[0]).toMatchObject({ startClock: 0, expiryClock: 108 });
  });

  it('cover ends exactly at the expiry point; an unused policy expires with no refund and no reward', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    scheduleFrom(g, 1000); // no crisis in this test
    rollTo(g, COVER - 1);
    expect(policyStanding(g.state, ins(g).policies[0]!)).toBe('IN_FORCE');
    g.act(g.current, { type: 'END_TURN' });
    expect(g.current).toBe('Bilal');
    const cash = g.balance('Asha');
    // Bilal's roll reaches the expiry point (and begins Year 2).
    const result = rollTo(g, COVER);
    expect(types(result)).toContain('INSURANCE_EXPIRED');
    expect(ins(g).policies[0]).toMatchObject({ status: 'EXPIRED', claimedTotal: 0 });
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(policyStanding(g.state, ins(g).policies[0]!)).toBe('EXPIRED');
    expect(g.balance('Asha')).toBe(cash);
    expect(result.transactions.filter((t) => t.type === 'INSURANCE_PREMIUM' || t.toPlayerId === g.id('Asha'))).toEqual([]);
  });

  it('a lapsed policy is bought again as a new one: this year’s price, no discounts', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    scheduleFrom(g, 1000);
    rollTo(g, COVER + 30); // past the renewal grace (12 spaces = 24 on the clock)
    expect(eco(g).year).toBe(2);
    expect(renewalBlocker(g.state, g.id('Asha'), ins(g).policies[0]!.id)).toBe('Too late to renew — insure the properties again as a new policy.');
    expect(propertyInsurance(g.state, 'MUMBAI')).toMatchObject({ active: null, premium: 300, year: 2 });
    g.act(g.current, { type: 'END_TURN' });
    insure(g, 'Asha', 'MUMBAI');
    expect(ins(g).policies.map((p) => [p.status, p.premiumPaid, p.entryYear, p.renewalOf])).toEqual([
      ['EXPIRED', P1, 1, null],
      ['ACTIVE', 300, 2, null],
    ]);
  });
});

describe('the crisis schedule', () => {
  it('first checkpoint at 18 average spaces, then every 36: 18, 54, 90, 126', () => {
    const two = eco(newGame());
    expect([1, 2, 3, 4].map((n) => crisisCheckpointClock(two, n))).toEqual([36, 108, 180, 252]);
    expect([1, 2, 3, 4].map((n) => averageSpaces(two, crisisCheckpointClock(two, n)))).toEqual([18, 54, 90, 126]);
    const three = eco(newGame(['Asha', 'Bilal', 'Chitra']));
    expect([1, 2, 3].map((n) => crisisCheckpointClock(three, n))).toEqual([54, 162, 270]);
  });

  it('nothing happens before the checkpoint, and the roll that reaches it resolves it exactly once', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    rollTo(g, FIRST - 1);
    expect(ins(g).crises).toEqual([]);
    g.act(g.current, { type: 'END_TURN' });
    const struck = rollTo(g, FIRST);
    expect(types(struck).filter((t) => t.startsWith('CRISIS'))).toEqual(['CRISIS_COVERED']);
    expect(ins(g)).toMatchObject({ nextCheckpoint: 2 });
    expect(ins(g).crises).toHaveLength(1);
    expect(crisisAt(g, 1)).toMatchObject({ checkpointClock: 36, year: 1, propertyKey: 'MUMBAI', ownerId: g.id('Asha'), status: 'COVERED' });
    // Later rolls before the next checkpoint add nothing.
    g.act(g.current, { type: 'END_TURN' });
    for (const clock of [FIRST + 3, FIRST + 20, SECOND - 1]) {
      const r = rollTo(g, clock);
      expect(types(r).filter((t) => t.startsWith('CRISIS'))).toEqual([]);
      g.act(g.current, { type: 'END_TURN' });
    }
    expect(ins(g).crises).toHaveLength(1);
  });

  it('nobody owns anything: the checkpoint is recorded as skipped and the schedule does not shift', () => {
    const g = newGame();
    const r = rollTo(g, FIRST);
    expect(types(r).filter((t) => t.startsWith('CRISIS'))).toEqual([]);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'SKIPPED', propertyKey: null, ownerId: null, amount: 0 });
    expect(pendingCrises(g.state)).toEqual([]);
    g.act(g.current, { type: 'END_TURN' });
    // The next checkpoint is still at 54 average spaces.
    g.give('Asha', 'MUMBAI');
    rollTo(g, SECOND - 1);
    expect(ins(g).crises).toHaveLength(1);
    g.act(g.current, { type: 'END_TURN' });
    rollTo(g, SECOND);
    expect(crisisAt(g, 2)).toMatchObject({ checkpointClock: SECOND, year: 2, propertyKey: 'MUMBAI', status: 'PENDING' });
  });

  it('exactly one eligible property is selected without a draw', () => {
    const g = newGame();
    g.give('Bilal', 'AGRA');
    rollTo(g, FIRST);
    expect(crisisAt(g, 1)).toMatchObject({ propertyKey: 'AGRA', ownerId: g.id('Bilal') });
    // No queued RNG value was left over: the next roll shows the dice it was given.
    pay(g, 'Bilal');
    g.act(g.current, { type: 'END_TURN' });
    expect(g.roll(g.current, 3, 4).state.turn.roll).toMatchObject({ dice: [3, 4] });
  });

  it('one property across all players, chosen by the server’s RNG — mortgaged ones included', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI', { mortgaged: true });
    g.give('Chitra', 'AGRA');
    const r = rollTo(g, 54, 'DELHI');
    expect(ins(g).crises).toHaveLength(1);
    expect(crisisAt(g, 1)).toMatchObject({ propertyKey: 'DELHI', ownerId: g.id('Bilal'), mortgaged: true, amount: BILL, status: 'PENDING' });
    expect(types(r).filter((t) => t.startsWith('CRISIS'))).toEqual(['CRISIS_STRUCK']);
  });

  it('every draw outcome is one of the eligible properties, and each can be reached', () => {
    const seen = new Set<string>();
    for (const value of [0, 0.34, 0.67, 0.999]) {
      const g = newGame();
      g.give('Asha', 'MUMBAI');
      g.give('Asha', 'DELHI');
      g.give('Bilal', 'AGRA');
      setClock(g, FIRST - 3);
      g.placeAt(g.current, BOARD_SIZE - 3);
      g.queueRandom(faceToRandom(1), faceToRandom(2), value);
      g.act(g.current, { type: 'ROLL_DICE' });
      seen.add(crisisAt(g, 1).propertyKey!);
    }
    expect([...seen].sort()).toEqual(['AGRA', 'DELHI', 'MUMBAI']);
  });

  it('a property sold before the checkpoint, or held by a player who left or went bankrupt, is not eligible', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI');
    g.give('Chitra', 'AGRA');
    g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' });
    g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(eligibleKeys(g)).toEqual(['DELHI']);
    rollTo(g, 54);
    expect(crisisAt(g, 1)).toMatchObject({ propertyKey: 'DELHI', ownerId: g.id('Asha') });
  });

  it('a roll that crosses several checkpoints resolves each one, in order, once', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    const r = rollTo(g, SECOND);
    expect(ins(g).crises.map((c) => [c.checkpoint, c.checkpointClock, c.status])).toEqual([
      [1, FIRST, 'PENDING'],
      [2, SECOND, 'PENDING'],
    ]);
    expect(types(r).filter((t) => t.startsWith('CRISIS'))).toEqual(['CRISIS_STRUCK', 'CRISIS_STRUCK']);
    expect(ins(g).nextCheckpoint).toBe(3);
    // Both bills are owed, oldest first; play resumes only when both are settled.
    const before = g.balance('Asha');
    pay(g, 'Asha', crisisAt(g, 1).id);
    expect(refusal(() => g.act(g.current, { type: 'END_TURN' })).code).toBe('INVALID_PHASE');
    pay(g, 'Asha', crisisAt(g, 2).id);
    expect(g.balance('Asha')).toBe(before - 2 * BILL);
    g.act(g.current, { type: 'END_TURN' });
  });

  it('a game that started before insurance existed carries on without it', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    delete eco(g).insurance;
    expect(insureBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBe('This game started before property insurance existed.');
    expect(refusal(() => g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 500 })).code).toBe('INSURANCE_NOT_ALLOWED');
    const r = rollTo(g, SECOND);
    expect(types(r).filter((t) => t.startsWith('CRISIS'))).toEqual([]);
    expect(eco(g).insurance).toBeUndefined();
    g.act(g.current, { type: 'END_TURN' });
  });
});

describe('claims and the payout limit', () => {
  it('an insured property: the claim pays the whole bill automatically, no cash moves and play carries on', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const cash = { Asha: g.balance('Asha'), Bilal: g.balance('Bilal') };
    const roller = g.current;
    const r = rollTo(g, FIRST);
    const crisis = crisisAt(g, 1);
    const p = ins(g).policies[0]!;
    expect(crisis).toMatchObject({ type: 'PROPERTY_CRISIS', status: 'COVERED', amount: BILL, covered: BILL, paid: 0, policyId: p.id });
    expect(crisisDue(crisis)).toBe(0);
    // The policy is not used up by one claim: it stays in force with what it has left.
    expect(policy(g, p.id)).toMatchObject({ status: 'ACTIVE', claimedTotal: BILL });
    expect(remainingCover(policy(g, p.id))).toBe(0);
    expect(r.events.find((e) => e.type === 'CRISIS_COVERED')!.payload).toMatchObject({ covered: BILL, policyId: p.id });
    expect(r.transactions.map((t) => t.type)).toEqual(['START_REWARD']);
    expect(g.balance('Asha')).toBe(cash.Asha + (roller === 'Asha' ? START_REWARD : 0));
    expect(pendingCrises(g.state)).toEqual([]);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
    g.act(roller, { type: 'END_TURN' });
  });

  it('pays the loss less the deductible, never more than the limit left (pure)', () => {
    const p = { payoutLimit: 3000, claimedTotal: 0, deductible: 0 };
    expect(claimPayout(p, 3000)).toBe(3000);
    expect(claimPayout({ ...p, claimedTotal: 1000 }, 3000)).toBe(2000);
    expect(claimPayout({ ...p, claimedTotal: 3000 }, 3000)).toBe(0);
    expect(claimPayout({ ...p, deductible: 500 }, 3000)).toBe(2500);
    expect(claimPayout({ ...p, deductible: 500 }, 400)).toBe(0);
    expect(claimPayout({ payoutLimit: 6000, claimedTotal: 0, deductible: 0 }, 3000)).toBe(3000);
  });

  it('only the property crisis is a covered type', () => {
    expect(isCoveredCrisis('PROPERTY_CRISIS')).toBe(true);
    expect(INS.coveredCrises).toEqual(['PROPERTY_CRISIS']);
  });

  it('several crises in one period are each paid while the limit lasts', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    // Test surgery: the default schedule puts one crisis in a period; stretch this one over two, with room for both.
    const p = ins(g).policies[0]!;
    p.expiryClock = SECOND + 10;
    p.payoutLimit = 2 * BILL;
    advance(g, FIRST);
    advance(g, SECOND);
    expect([crisisAt(g, 1), crisisAt(g, 2)].map((c) => [c.status, c.covered, c.policyId])).toEqual([
      ['COVERED', BILL, p.id],
      ['COVERED', BILL, p.id],
    ]);
    expect(policy(g, p.id).claimedTotal).toBe(2 * BILL);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('when the limit left is lower than the loss, it pays what is left and the owner owes the rest', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const p = ins(g).policies[0]!;
    p.expiryClock = SECOND + 10;
    p.payoutLimit = 5000;
    advance(g, FIRST);
    expect(remainingCover(policy(g, p.id))).toBe(2000);
    if (g.state.turn.phase === 'TURN_COMPLETE') g.act(g.current, { type: 'END_TURN' });
    const r = rollTo(g, SECOND);
    const crisis = crisisAt(g, 2);
    expect(crisis).toMatchObject({ status: 'PENDING', amount: BILL, covered: 2000, paid: 0, policyId: p.id });
    expect(crisisDue(crisis)).toBe(1000);
    expect(r.events.find((e) => e.type === 'CRISIS_STRUCK')!.message).toContain('paid ₹2,000');
    expect(financialOverview(g.state, g.id('Asha'))!.crisisOwed).toBe(1000);
    expect(refusal(() => g.act('Bilal', { type: 'END_TURN' })).message).toBe('Waiting for Asha to settle a ₹1,000 crisis bill.');
    const before = g.balance('Asha');
    const paid = pay(g, 'Asha');
    expect(paid.transactions).toMatchObject([{ type: 'CRISIS_PAYMENT', amount: 1000 }]);
    expect(g.balance('Asha')).toBe(before - 1000);
    expect(crisisAt(g, 2)).toMatchObject({ status: 'PAID', paid: 1000, covered: 2000 });
    expect(policy(g, p.id).claimedTotal).toBe(5000);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('once the limit is used up, a further crisis in the period is not paid', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const p = ins(g).policies[0]!;
    p.expiryClock = SECOND + 10;
    advance(g, FIRST);
    expect(remainingCover(policy(g, p.id))).toBe(0);
    if (g.state.turn.phase === 'TURN_COMPLETE') g.act(g.current, { type: 'END_TURN' });
    const r = rollTo(g, SECOND);
    expect(crisisAt(g, 2)).toMatchObject({ status: 'PENDING', covered: 0, policyId: null, amount: BILL });
    expect(r.events.find((e) => e.type === 'CRISIS_STRUCK')!.message).toContain('nothing left to pay');
    expect(policy(g, p.id).claimedTotal).toBe(BILL);
    // An exhausted policy still holds the property: it can't be insured again until the period ends.
    pay(g, 'Asha');
    expect(insureBlocker(g.state, g.id('Asha'), 'MUMBAI')).toContain('Already insured');
  });

  it('a crisis on another property of the owner is not covered by a policy that does not list it', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI');
    insure(g, 'Asha', 'MUMBAI');
    rollTo(g, FIRST, 'DELHI');
    expect(crisisAt(g, 1)).toMatchObject({ propertyKey: 'DELHI', status: 'PENDING', covered: 0, policyId: null });
    expect(ins(g).policies[0]!.claimedTotal).toBe(0);
  });

  it('a checkpoint is claimed once: replaying the schedule never pays a crisis twice', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    advance(g, FIRST);
    // Test surgery: rewind the schedule as a retried or duplicated roll would; the recorded crisis is not resolved again.
    ins(g).nextCheckpoint = 1;
    advance(g, FIRST + 3);
    expect(ins(g).crises).toHaveLength(1);
    expect(ins(g).policies[0]!.claimedTotal).toBe(BILL);
  });

  it('a policy that expires at the checkpoint does not cover it; one that ends just after does', () => {
    const expired = newGame();
    expired.give('Asha', 'MUMBAI');
    setClock(expired, SECOND - COVER);
    scheduleFrom(expired, SECOND - COVER);
    insure(expired, 'Asha', 'MUMBAI');
    expect(ins(expired).policies[0]!.expiryClock).toBe(SECOND);
    const r = rollTo(expired, SECOND);
    expect(crisisAt(expired, 2)).toMatchObject({ status: 'PENDING', policyId: null, covered: 0 });
    expect(ins(expired).policies[0]).toMatchObject({ status: 'EXPIRED', claimedTotal: 0 });
    expect(types(r)).toEqual(expect.arrayContaining(['CRISIS_STRUCK', 'INSURANCE_EXPIRED']));

    const live = newGame();
    live.give('Asha', 'MUMBAI');
    setClock(live, SECOND - COVER + 1);
    scheduleFrom(live, SECOND - COVER + 1);
    insure(live, 'Asha', 'MUMBAI');
    rollTo(live, SECOND);
    expect(crisisAt(live, 2).status).toBe('COVERED');
  });

  it('cover is judged at the checkpoint, not at the roll that crossed it', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    setClock(g, SECOND - COVER + 1);
    scheduleFrom(g, SECOND - COVER + 1);
    insure(g, 'Asha', 'MUMBAI'); // ends at SECOND + 1
    // A roll of 3 from SECOND − 1 passes the checkpoint and the expiry point together.
    rollTo(g, SECOND + 2);
    expect(crisisAt(g, 2)).toMatchObject({ checkpointClock: SECOND, status: 'COVERED' });
    expect(ins(g).policies[0]).toMatchObject({ status: 'EXPIRED', claimedTotal: BILL });
  });

  it('insurance bought after a crisis was selected never covers it', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    rollTo(g, FIRST);
    expect(crisisAt(g, 1).status).toBe('PENDING');
    // Not while the bill is open…
    expect(refusal(() => insure(g, 'Asha', 'MUMBAI')).code).toBe('INVALID_PHASE');
    expect(ins(g).policies).toEqual([]);
    // …and a policy bought once it is paid leaves that bill paid.
    const before = g.balance('Asha');
    pay(g, 'Asha');
    insure(g, 'Asha', 'MUMBAI');
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL, covered: 0, policyId: null });
    expect(g.balance('Asha')).toBe(before - BILL - P1);
    expect(ins(g).policies[0]).toMatchObject({ status: 'ACTIVE', startClock: FIRST, claimedTotal: 0 });
  });
});

describe('mortgaged properties', () => {
  it('insured and mortgaged: the bill is paid and the mortgage, buildings and owner are untouched', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { mortgaged: true, houses: 2 });
    const redeem = unmortgageCost('MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    rollTo(g, FIRST);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'COVERED', mortgaged: true });
    expect(g.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: g.id('Asha'), houses: 2, hotel: false, mortgaged: true });
    expect(unmortgageCost('MUMBAI')).toBe(redeem);
  });

  it('uninsured and mortgaged: the full ₹3,000 is owed, and nothing about the property changes', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI', { mortgaged: true, hotel: true });
    rollTo(g, FIRST);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PENDING', amount: BILL, mortgaged: true });
    pay(g, 'Asha');
    expect(g.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: g.id('Asha'), houses: 0, hotel: true, mortgaged: true });
  });
});

describe('renewal', () => {
  /** Asha owns MUMBAI (insured at clock 0, period [0, 72)); Bilal owns AGRA, uninsured, which the crises strike unless told otherwise. */
  function insured() {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'AGRA');
    insure(g, 'Asha', 'MUMBAI');
    return { g, first: ins(g).policies[0]! };
  }

  it('is optional and never automatic: an unrenewed policy simply ends', () => {
    const { g, first } = insured();
    advance(g, FIRST, 'AGRA');
    const cash = g.balance('Asha');
    advance(g, COVER + 30, 'AGRA');
    expect(policy(g, first.id).status).toBe('EXPIRED');
    expect(ins(g).policies).toHaveLength(1);
    expect(g.ledger.filter((t) => t.type === 'INSURANCE_PREMIUM')).toHaveLength(1);
    expect(g.balance('Asha')).toBeGreaterThanOrEqual(cash);
  });

  it('opens once the period’s crisis has passed and closes 12 spaces after cover ends', () => {
    const { g, first } = insured();
    expect(renewalWindow(eco(g), first)).toEqual({ opensAt: FIRST, closesAt: COVER + 24 });
    advance(g, 10);
    expect(renewalBlocker(g.state, g.id('Asha'), first.id)).toBe("Renewal opens after this period's crisis, in 13 spaces.");
    expect(refusal(() => renew(g, 'Asha', first.id, 175)).code).toBe('INSURANCE_NOT_ALLOWED');
    advance(g, FIRST, 'AGRA');
    expect(renewalBlocker(g.state, g.id('Asha'), first.id)).toBeNull();
  });

  it('renewed early, the new period starts when the old one ends, with a fresh limit and both discounts', () => {
    const { g, first } = insured();
    advance(g, FIRST + 4, 'AGRA'); // claim-free period, Year 1 buyer
    const offer = renewalOffer(g.state, policy(g, first.id))!;
    // 250 less 20% early-buyer and 10% no-claim.
    expect(offer.pricing).toMatchObject({ basePremium: 250, loyaltyPercent: 20, noClaimPercent: 10, discountPercent: 30, premium: 175 });
    const cash = g.balance('Asha');
    const r = renew(g, 'Asha', first.id);
    expect(types(r)).toEqual(['INSURANCE_RENEWED']);
    expect(r.transactions).toMatchObject([{ type: 'INSURANCE_PREMIUM', amount: 175, fromPlayerId: g.id('Asha') }]);
    expect(g.balance('Asha')).toBe(cash - 175);
    const next = ins(g).policies[1]!;
    expect(next).toMatchObject({ renewalOf: first.id, entryYear: 1, noClaimPeriods: 1, startClock: COVER, expiryClock: 2 * COVER, claimedTotal: 0, payoutLimit: BILL, propertyKeys: ['MUMBAI'] });
    // The old period still covers until it ends; the renewal is booked behind it.
    expect(activePolicyFor(g.state, 'MUMBAI')!.id).toBe(first.id);
    expect(policyStanding(g.state, next)).toBe('UPCOMING');
    advance(g, SECOND, 'MUMBAI');
    expect(policy(g, first.id).status).toBe('EXPIRED');
    expect(crisisAt(g, 2)).toMatchObject({ propertyKey: 'MUMBAI', status: 'COVERED', policyId: next.id });
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('a renewal is applied once: a repeated or stale request never charges twice', () => {
    const { g, first } = insured();
    advance(g, FIRST + 4, 'AGRA');
    expect(refusal(() => renew(g, 'Asha', first.id, 250)).code).toBe('STALE_STATE');
    renew(g, 'Asha', first.id);
    const cash = g.balance('Asha');
    const again = refusal(() => renew(g, 'Asha', first.id, 175));
    expect(again).toEqual({ code: 'INSURANCE_NOT_ALLOWED', message: 'This policy has already been renewed.' });
    expect(g.balance('Asha')).toBe(cash);
    expect(ins(g).policies).toHaveLength(2);
    // Nor can the property be insured a second time alongside the booked renewal.
    expect(insureBlocker(g.state, g.id('Asha'), 'MUMBAI')).toContain('Already insured');
    expect(refusal(() => renew(g, 'Bilal', first.id, 175)).code).toBe('NOT_FOUND');
  });

  it('renewed after cover ended (within the grace), cover starts at once; later it is too late', () => {
    const { g, first } = insured();
    advance(g, FIRST, 'AGRA');
    advance(g, COVER + 10, 'AGRA');
    expect(policy(g, first.id).status).toBe('EXPIRED');
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    renew(g, 'Asha', first.id);
    expect(ins(g).policies[1]).toMatchObject({ startClock: COVER + 10, expiryClock: 2 * COVER + 10, noClaimPeriods: 1 });

    const late = insured();
    advance(late.g, FIRST, 'AGRA');
    advance(late.g, COVER + 24, 'AGRA');
    expect(refusal(() => renew(late.g, 'Asha', late.first.id, 175)).message).toBe('Too late to renew — insure the properties again as a new policy.');
  });

  it('no-claim discount grows 10% → 20% → 30% and stays there; a claim resets it but keeps the early-buyer discount', () => {
    const { g, first } = insured();
    advance(g, FIRST + 4, 'AGRA');
    renew(g, 'Asha', first.id); // Year 1: 250 − 30% = 175
    const second = ins(g).policies[1]!;
    advance(g, SECOND + 2, 'AGRA'); // Year 2
    renew(g, 'Asha', second.id); // 300 − (20 + 20)% = 180
    const third = ins(g).policies[2]!;
    advance(g, THIRD + 2, 'AGRA'); // Year 3
    renew(g, 'Asha', third.id); // 350 − min(50, 20 + 30)% = 175
    const fourth = ins(g).policies[3]!;
    expect([second, third, fourth].map((p) => [p.pricing.loyaltyPercent, p.pricing.noClaimPercent, p.premiumPaid])).toEqual([
      [20, 10, 175],
      [20, 20, 180],
      [20, 30, 175],
    ]);
    // Period four is struck: the claim is paid in full …
    advance(g, FOURTH + 2, 'MUMBAI');
    expect(crisisAt(g, 4)).toMatchObject({ status: 'COVERED', policyId: fourth.id });
    // … and the renewal after it loses the no-claim run, not the early-buyer discount. Year 4: 400 − 20% = 320.
    renew(g, 'Asha', fourth.id);
    expect(ins(g).policies[4]!.pricing).toMatchObject({ basePremium: 400, loyaltyPercent: 20, noClaimPercent: 0, premium: 320 });
    expect(ins(g).policies[4]).toMatchObject({ noClaimPeriods: 0, entryYear: 1 });
    // Claim history stays with the period it belongs to.
    expect(policy(g, fourth.id).claimedTotal).toBe(BILL);
    expect(ins(g).policies[4]!.claimedTotal).toBe(0);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('a newcomer in a later year pays more than a renewing early buyer', () => {
    const { g, first } = insured();
    g.give('Bilal', 'DELHI');
    advance(g, FIRST + 4, 'AGRA');
    renew(g, 'Asha', first.id);
    advance(g, SECOND + 2, 'AGRA');
    const loyal = renewalOffer(g.state, ins(g).policies[1]!)!.pricing.premium;
    const newcomer = insuranceQuote({ year: eco(g).year, properties: 1 }).premium;
    expect([loyal, newcomer]).toEqual([180, 300]);
  });

  it('without the cash the renewal is refused and nothing changes', () => {
    const { g, first } = insured();
    advance(g, FIRST + 4, 'AGRA');
    leaveWith(g, 'Asha', 100, 'Bilal');
    expect(renewalBlocker(g.state, g.id('Asha'), first.id)).toBe('Not enough money — the renewal premium is ₹175.');
    expect(refusal(() => renew(g, 'Asha', first.id, 175)).code).toBe('INSUFFICIENT_FUNDS');
    expect(g.balance('Asha')).toBe(100);
    expect(ins(g).policies).toHaveLength(1);
  });

  it('renews only the properties still insured, priced for that many', () => {
    const g = newGame();
    for (const key of ['MUMBAI', 'DELHI', 'AGRA'] as const) g.give('Asha', key);
    g.give('Bilal', 'MADRAS');
    insureAll(g, 'Asha', ['MUMBAI', 'DELHI', 'AGRA']);
    const first = ins(g).policies[0]!;
    tradeAway(g, 'Asha', 'Bilal', ['AGRA']);
    advance(g, FIRST + 4, 'MADRAS');
    const offer = renewalOffer(g.state, policy(g, first.id))!;
    // Two properties: 500 less 5% portfolio, 20% early-buyer, 10% no-claim.
    expect(offer.pricing).toMatchObject({ properties: 2, grossPremium: 500, discountPercent: 35, premium: 325 });
    renew(g, 'Asha', first.id);
    expect(ins(g).policies[1]!.propertyKeys).toEqual(['MUMBAI', 'DELHI']);
  });
});

describe('settling an uninsured crisis', () => {
  /** Asha owns MUMBAI uninsured; Bilal's roll reaches the first checkpoint. */
  function struck(names = ['Asha', 'Bilal']) {
    const g = newGame(names);
    g.give('Asha', 'MUMBAI');
    // Asha plays first: her turn passes without reaching the checkpoint.
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    expect(g.current).toBe('Bilal');
    const first = crisisCheckpointClock(eco(g), 1);
    const result = rollTo(g, first);
    return { g, result, crisis: crisisAt(g, 1) };
  }

  it('creates exactly one ₹3,000 obligation for the owner, whoever’s turn it is', () => {
    const { g, result, crisis } = struck();
    expect(pendingCrises(g.state)).toHaveLength(1);
    expect(crisis).toMatchObject({ ownerId: g.id('Asha'), amount: BILL, paid: 0, status: 'PENDING', settledAt: null });
    expect(result.transactions.filter((t) => t.type === 'CRISIS_PAYMENT')).toEqual([]);
    expect(g.state.turn.playerId).toBe(g.id('Bilal'));
    expect(financialOverview(g.state, g.id('Asha'))!.crisisOwed).toBe(BILL);
    expect(netWorth(g.state, g.id('Asha'))).toBe(financialOverview(g.state, g.id('Asha'))!.netWorth);
  });

  it('nothing moves on until it is paid: no end of turn, no roll, no trade, no building, no insurance', () => {
    const { g } = struck();
    const blocked: [string, GameAction][] = [
      ['Bilal', { type: 'END_TURN' }],
      ['Bilal', { type: 'ROLL_DICE' }],
      ['Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: [], requestedPropertyKeys: ['MUMBAI'], offeredMoney: 5000, requestedMoney: 0 }],
      ['Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 5000 }],
      ['Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 500 }],
      ['Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' }],
      ['Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 }],
      ['Bilal', { type: 'DECLARE_BANKRUPTCY' }],
    ];
    for (const [name, action] of blocked) {
      const r = refusal(() => g.act(name, action));
      expect([name, action.type, r.code]).toEqual([name, action.type, 'INVALID_PHASE']);
      expect(r.message).toBe(name === 'Asha' ? 'Settle your ₹3,000 crisis bill first.' : 'Waiting for Asha to settle a ₹3,000 crisis bill.');
    }
    expect(pendingCrises(g.state)).toHaveLength(1);
  });

  it('a trade offered before the crisis cannot be accepted until the bill is settled', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: [], requestedPropertyKeys: ['MUMBAI'], offeredMoney: 9000, requestedMoney: 0 });
    const tradeId = g.state.trades[0]!.id;
    rollTo(g, FIRST);
    expect(refusal(() => g.act('Asha', { type: 'ACCEPT_TRADE', tradeId })).code).toBe('INVALID_PHASE');
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    // The bill was hers when the property was struck, and stays hers.
    pay(g, 'Asha');
    g.act('Asha', { type: 'ACCEPT_TRADE', tradeId });
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Bilal'));
    expect(crisisAt(g, 1)).toMatchObject({ ownerId: g.id('Asha'), status: 'PAID' });
  });

  it('paying settles it once: the cash leaves once, a second payment is refused, and the turn carries on', () => {
    const { g, crisis } = struck();
    const before = g.balance('Asha');
    const paid = pay(g, 'Asha', crisis.id);
    expect(paid.transactions).toMatchObject([{ type: 'CRISIS_PAYMENT', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: BILL, propertyKey: 'MUMBAI' }]);
    expect(types(paid)).toEqual(['CRISIS_SETTLED']);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL });
    const again = refusal(() => pay(g, 'Asha', crisis.id));
    expect(again).toEqual({ code: 'INVALID_PHASE', message: 'This crisis bill is already settled.' });
    expect(g.balance('Asha')).toBe(before - BILL);
    // The turn is where it was: Bilal finishes it.
    expect(g.state.turn).toMatchObject({ playerId: g.id('Bilal'), phase: 'TURN_COMPLETE' });
    g.act('Bilal', { type: 'END_TURN' });
    expect(g.current).toBe('Asha');
  });

  it('only the player who owes can pay, and only their own bill', () => {
    const { g, crisis } = struck();
    expect(refusal(() => g.act('Bilal', { type: 'PAY_CRISIS_BILL', crisisId: crisis.id })).code).toBe('INVALID_PHASE');
    expect(refusal(() => g.act('Asha', { type: 'PAY_CRISIS_BILL', crisisId: g.id('Asha') })).code).toBe('NOT_FOUND');
    expect(crisisAt(g, 1).status).toBe('PENDING');
  });

  it('pausing, resuming and reloading the stored state keep the exact obligation and its restrictions', () => {
    const { g, crisis } = struck();
    g.act('Bilal', { type: 'PAUSE_GAME' });
    expect(refusal(() => g.act('Asha', { type: 'PAY_CRISIS_BILL', crisisId: crisis.id })).code).toBe('GAME_PAUSED');
    g.act('Asha', { type: 'RESUME_GAME' });
    // A reconnecting device gets the state back from storage: plain JSON, same bill.
    g.state = JSON.parse(JSON.stringify(g.state));
    expect(pendingCrisisOf(g.state, g.id('Asha'))).toMatchObject({ id: crisis.id, amount: BILL, paid: 0, status: 'PENDING' });
    expect(crisisRecoveryOptions(g.state, g.id('Asha'))).toEqual(['mortgage a property', 'sell a property to the bank', 'take a loan (optional)']);
    expect(refusal(() => g.act('Bilal', { type: 'END_TURN' })).code).toBe('INVALID_PHASE');
    pay(g, 'Asha');
    g.act('Bilal', { type: 'END_TURN' });
  });

  it('short of cash: payment and bankruptcy are both refused while money can still be raised', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    leaveWith(g, 'Asha', 200, 'Bilal');
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    leaveWith(g, 'Asha', 200, 'Bilal');
    rollTo(g, FIRST);
    const crisis = crisisAt(g, 1);
    expect(refusal(() => pay(g, 'Asha')).code).toBe('INSUFFICIENT_FUNDS');
    expect(g.player('Asha').status).toBe('ACTIVE');
    const bankrupt = refusal(() => g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisis.id }));
    expect(bankrupt.code).toBe('INVALID_PHASE');
    // Borrowing is offered, but never required: it is not one of the reasons bankruptcy is refused.
    expect(bankrupt.message).toBe('You can still raise the ₹3,000: mortgage a property, sell a property to the bank. Bankruptcy is only possible when even that would not be enough.');
    expect(crisisBankruptcyBlocker(g.state, g.id('Asha'), crisis)).toBe(bankrupt.message);
    // Mortgaging is one of the existing ways to raise money (₹4,250 for Mumbai).
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(g.balance('Asha')).toBe(200 + 4250);
    pay(g, 'Asha');
    expect(g.balance('Asha')).toBe(200 + 4250 - BILL);
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), mortgaged: true });
    g.act('Bilal', { type: 'END_TURN' });
  });

  it('a loan the bank offers, a building sold, or money from another player also raise the cash', () => {
    const g = newGame();
    g.giveGroup('Asha', 'MUMBAI', { houses: 1 });
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    leaveWith(g, 'Asha', 0, 'Bilal');
    rollTo(g, FIRST, 'MUMBAI');
    expect(pendingCrisisOf(g.state, g.id('Asha'))).not.toBeNull();
    expect(crisisRecoveryOptions(g.state, g.id('Asha'))).toEqual(['sell a building', 'mortgage a property', 'sell a property to the bank', 'take a loan (optional)']);
    g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    borrow(g, 'Asha', 'EMERGENCY', 10000);
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 1000 });
    expect(g.balance('Asha')).toBeGreaterThanOrEqual(BILL);
    pay(g, 'Asha');
    expect(pendingCrises(g.state)).toEqual([]);
  });

  it('with the cash in hand, bankruptcy is refused', () => {
    const { g, crisis } = struck();
    expect(refusal(() => g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisis.id })).message).toBe('You can afford this bill.');
    expect(g.player('Asha').status).toBe('ACTIVE');
  });
});

describe('bankruptcy over a crisis bill', () => {
  /**
   * Asha has used up every way of raising money: she is at the borrowing limit, and her one
   * property (Delhi, with three houses) is pledged to a loan with its buildings, so neither it nor
   * its houses can be sold or mortgaged.
   */
  function exhausted(names: string[]) {
    const g = newGame(names);
    g.give('Asha', 'DELHI', { houses: 3 });
    borrow(g, 'Asha', 'SECURED', 10000, ['DELHI']);
    borrow(g, 'Asha', 'PERSONAL', 10000);
    return g;
  }

  it('is allowed once the bank would not pay enough for what she owns; the estate pays the bill first', () => {
    const g = exhausted(['Asha', 'Bilal', 'Chitra']);
    const last = names3(g);
    leaveWith(g, 'Asha', 100, last);
    const first = crisisCheckpointClock(eco(g), 1);
    rollTo(g, first); // Asha's own roll: + ₹1,500 at Start
    const crisis = crisisAt(g, 1);
    expect(crisis).toMatchObject({ propertyKey: 'DELHI', ownerId: g.id('Asha'), status: 'PENDING' });
    expect(g.balance('Asha')).toBe(100 + START_REWARD);
    expect(crisisRecoveryOptions(g.state, g.id('Asha'))).toEqual([]);
    expect(crisisBankruptcyBlocker(g.state, g.id('Asha'), crisis)).toBeNull();

    const r = g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisis.id });
    expect(types(r)).toContain('PLAYER_BANKRUPT');
    // Delhi could not be sold or mortgaged while pledged; now it is taken for its own loan at market value,
    // and the surplus is the estate's cash — which pays the crisis bill first, then the other loans.
    const [secured, ...unsecured] = eco(g).loans;
    const surplus = r.transactions.find((t) => t.type === 'COLLATERAL_SURPLUS')!.amount;
    // Recovered at market value plus the houses at what the bank pays for them (half their cost).
    const houses = Math.floor((3 * (getDeed('DELHI') as { houseCost: number }).houseCost) / 2);
    expect(secured).toMatchObject({ status: 'SETTLED', settlement: { propertyKeys: ['DELHI'], value: eco(g).market.DELHI.value + houses, surplus } });
    expect(r.transactions.filter((t) => t.type === 'CRISIS_PAYMENT').map((t) => t.amount)).toEqual([BILL]);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL });
    const paidOut = r.transactions.filter((t) => t.fromPlayerId === g.id('Asha')).reduce((s, t) => s + t.amount, 0);
    expect(paidOut).toBe(100 + START_REWARD + surplus);
    // What the estate could not pay on the other loans is recorded on them, not forgiven silently.
    const owedOnLoans = unsecured.reduce((s, l) => s + (l.writtenOff ?? 0), 0);
    expect(unsecured.map((l) => l.status)).toEqual(['WRITTEN_OFF']);
    expect(owedOnLoans).toBeGreaterThan(0);
    expect(r.events.find((e) => e.type === 'ESTATE_SETTLED')!.payload).toMatchObject({ kind: 'BANKRUPTCY', unpaid: owedOnLoans });
    expect(g.player('Asha')).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    expect(g.state.properties.DELHI).toMatchObject({ ownerId: null, mortgaged: false, houses: 0 });
    expect(pendingCrises(g.state)).toEqual([]);
    // It was her turn: it passes on, and the game continues for the others.
    expect(g.state.status).toBe('ACTIVE');
    expect(g.current).toBe('Bilal');
    g.roll('Bilal', 1, 2);
  });

  it('for a player whose turn it is not: the turn stays put, and rent owed to them is no longer owed', () => {
    const g = exhausted(['Asha', 'Bilal', 'Chitra']);
    rollTo(g, 9);
    g.act('Asha', { type: 'END_TURN' });
    leaveWith(g, 'Asha', 100, 'Chitra');
    // Bilal's roll reaches the checkpoint and lands him on Asha's Delhi: rent is due as well.
    const first = crisisCheckpointClock(eco(g), 1);
    setClock(g, first - 3);
    g.placeBefore('Bilal', 'DELHI', 3);
    g.roll('Bilal', 1, 2);
    const crisis = crisisAt(g, 1);
    expect(crisis.status).toBe('PENDING');
    expect(g.state.turn).toMatchObject({ playerId: g.id('Bilal'), phase: 'AWAITING_PAYMENT' });
    // The crisis comes first: the rent can't be paid around it.
    expect(refusal(() => g.act('Bilal', { type: 'PAY_RENT' })).code).toBe('INVALID_PHASE');

    const r = g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisis.id });
    expect(types(r)).toEqual(expect.arrayContaining(['PLAYER_BANKRUPT', 'PAYMENT_CANCELLED']));
    expect(g.player('Asha').status).toBe('BANKRUPT');
    expect(g.state.turn).toMatchObject({ playerId: g.id('Bilal'), phase: 'TURN_COMPLETE', pending: null });
    g.act('Bilal', { type: 'END_TURN' });
    expect(g.current).toBe('Chitra');
  });

  it('with two players the last one standing wins', () => {
    const g = exhausted(['Asha', 'Bilal']);
    leaveWith(g, 'Asha', 100, 'Bilal');
    rollTo(g, FIRST);
    const r = g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisisAt(g, 1).id });
    expect(g.state).toMatchObject({ status: 'FINISHED', winnerId: g.id('Bilal') });
    expect(types(r)).toEqual(expect.arrayContaining(['PLAYER_BANKRUPT', 'GAME_FINISHED']));
  });

  function names3(g: TestGame): string {
    return Object.keys(g.ids)[2]!;
  }
});

describe('leaving or ending the game with a bill open', () => {
  it('the game ending collects the bill before the winner is decided', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    rollTo(g, FIRST);
    const cash = g.balance('Asha');
    // No vote can be asked for while a bill is open; the game ends here because the other player walks away.
    expect(() => g.act('Asha', { type: 'REQUEST_END_VOTE' })).toThrow(/crisis bill/);
    const r = g.act('Bilal', { type: 'LEAVE_GAME' });
    expect(types(r).indexOf('CRISIS_SETTLED')).toBeGreaterThanOrEqual(0);
    expect(types(r).indexOf('CRISIS_SETTLED')).toBeLessThan(types(r).indexOf('GAME_FINISHED'));
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL });
    expect(g.balance('Asha')).toBe(cash - BILL);
    const standings = r.events.find((e) => e.type === 'GAME_FINISHED')!.payload.standings as { playerId: string; netWorth: number }[];
    expect(standings.find((s) => s.playerId === g.id('Asha'))!.netWorth).toBe(cash - BILL + eco(g).market.MUMBAI.value);
  });

  it('a bill the game’s end can’t collect in full still counts against the final net worth', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    leaveWith(g, 'Asha', 400, 'Bilal');
    rollTo(g, FIRST);
    // Bilal walks away: the game ends with Asha's bill open, and the end collects what cash there is.
    const r = g.act('Bilal', { type: 'LEAVE_GAME' });
    expect(crisisAt(g, 1)).toMatchObject({ status: 'UNPAID', paid: 400 });
    expect(types(r)).toContain('CRISIS_UNPAID');
    expect(g.balance('Asha')).toBe(0);
    expect(netWorth(g.state, g.id('Asha'))).toBe(eco(g).market.MUMBAI.value - (BILL - 400));
    expect(g.state.winnerId).toBe(g.id('Asha'));
  });

  it('leaving with a bill and too little cash: the estate sells to the bank to pay it in full', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    leaveWith(g, 'Asha', 400, 'Bilal');
    rollTo(g, crisisCheckpointClock(eco(g), 1));
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['PROPERTY_SALE', 4250],
      ['CRISIS_PAYMENT', BILL],
      ['ESTATE_SETTLEMENT', cash + 4250 - BILL],
    ]);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL });
    expect(g.state.properties.MUMBAI.ownerId).toBeNull();
    expect(g.player('Asha')).toMatchObject({ status: 'LEFT', balance: 0 });
  });

  it('leaving does not dodge the bill and does not leave the table waiting', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    rollTo(g, crisisCheckpointClock(eco(g), 1));
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(r.transactions).toMatchObject([
      { type: 'CRISIS_PAYMENT', amount: BILL },
      { type: 'ESTATE_SETTLEMENT', amount: cash - BILL, toPlayerId: null },
    ]);
    expect(g.player('Asha')).toMatchObject({ status: 'LEFT', balance: 0 });
    expect(crisisAt(g, 1).status).toBe('PAID');
    g.act('Bilal', { type: 'END_TURN' });
    expect(g.current).toBe('Chitra');
  });
});

describe('Classic Mode is untouched', () => {
  it('has no insurance, no crises and no new restrictions, however long the game runs', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Asha', 'MUMBAI');
    const seen: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const name = g.current;
      g.placeAt(name, BOARD_SIZE - 3);
      seen.push(...types(g.roll(name, 1, 2)), ...types(g.act(name, { type: 'END_TURN' })));
    }
    expect(g.state.intermediate).toBeNull();
    expect(seen.filter((t) => t.startsWith('CRISIS') || t.startsWith('INSURANCE'))).toEqual([]);
    expect(g.ledger.filter((t) => t.type === 'INSURANCE_PREMIUM' || t.type === 'CRISIS_PAYMENT')).toEqual([]);
    expect(pendingCrises(g.state)).toEqual([]);
  });

  it('refuses every insurance action', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.give('Asha', 'MUMBAI');
    const cash = g.balance('Asha');
    expect(refusal(() => g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 500 }))).toEqual({
      code: 'INSURANCE_NOT_ALLOWED',
      message: 'Property insurance is only available in Capital Mode.',
    });
    expect(refusal(() => g.act('Asha', { type: 'PAY_CRISIS_BILL', crisisId: g.id('Asha') })).code).toBe('NOT_FOUND');
    expect(refusal(() => g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: g.id('Asha') })).code).toBe('NOT_FOUND');
    expect(g.balance('Asha')).toBe(cash);
    expect(propertyInsurance(g.state, 'MUMBAI')).toBeNull();
  });
});

describe('buy and insure in one step', () => {
  function landed(mode: 'intermediate' | 'classic' = 'intermediate') {
    const g = new TestGame(['Asha', 'Bilal'], { mode });
    g.placeBefore('Asha', 'AGRA', 3);
    g.roll('Asha', 1, 2);
    expect(g.state.turn.pending).toMatchObject({ kind: 'BUY', propertyKey: 'AGRA' });
    return g;
  }

  it('one action buys the property and its policy: two ledger entries, cover from that moment', () => {
    const g = landed();
    const cash = g.balance('Asha');
    const price = (g.state.turn.pending as { price: number }).price;
    const r = g.act('Asha', { type: 'BUY_PROPERTY', insurePremium: P1 });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['PROPERTY_PURCHASE', price],
      ['INSURANCE_PREMIUM', P1],
    ]);
    expect(types(r)).toEqual(['PROPERTY_PURCHASED', 'INSURANCE_PURCHASED']);
    expect(g.balance('Asha')).toBe(cash - price - P1);
    expect(g.state.properties.AGRA.ownerId).toBe(g.id('Asha'));
    expect(g.state.turn).toMatchObject({ phase: 'TURN_COMPLETE', pending: null });
    expect(activePolicyFor(g.state, 'AGRA')).toMatchObject({ ownerId: g.id('Asha'), premiumPaid: P1, status: 'ACTIVE', propertyKeys: ['AGRA'] });
  });

  it('if the policy can’t be bought, the property isn’t either', () => {
    const stale = landed();
    const before = JSON.stringify(stale.state);
    expect(refusal(() => stale.act('Asha', { type: 'BUY_PROPERTY', insurePremium: 400 })).code).toBe('STALE_STATE');
    expect(JSON.stringify(stale.state)).toBe(before);

    const g = landed();
    const price = (g.state.turn.pending as { price: number }).price;
    leaveWith(g, 'Asha', price + P1 - 1, 'Bilal');
    expect(refusal(() => g.act('Asha', { type: 'BUY_PROPERTY', insurePremium: P1 })).code).toBe('INSUFFICIENT_FUNDS');
    expect(g.state.properties.AGRA.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(price + P1 - 1);
    // The plain purchase is still there.
    g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(g.state.properties.AGRA.ownerId).toBe(g.id('Asha'));
    expect(ins(g).policies).toEqual([]);
  });

  it('a Classic game refuses it and keeps its plain purchase', () => {
    const g = landed('classic');
    const cash = g.balance('Asha');
    expect(refusal(() => g.act('Asha', { type: 'BUY_PROPERTY', insurePremium: P1 })).code).toBe('INSURANCE_NOT_ALLOWED');
    expect(g.state.properties.AGRA.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(cash);
    const r = g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(r.transactions.map((t) => t.type)).toEqual(['PROPERTY_PURCHASE']);
  });
});

describe('insure all: one portfolio policy', () => {
  const KEYS = ['MUMBAI', 'DELHI', 'AGRA'] as const;
  function owning() {
    const g = newGame();
    for (const key of KEYS) g.give('Asha', key);
    return g;
  }

  it('one action, one policy, one premium for every uninsured property — cheaper than separate policies', () => {
    const g = owning();
    insure(g, 'Asha', 'DELHI');
    expect(uninsuredProperties(g.state, g.id('Asha')).sort()).toEqual(['AGRA', 'MUMBAI']);
    const r = insureAll(g, 'Asha', uninsuredProperties(g.state, g.id('Asha')));
    // Two properties: 2 × ₹250 less 5%.
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['INSURANCE_PREMIUM', 475]]);
    expect(g.balance('Asha')).toBe(START_CASH - P1 - 475);
    expect(ins(g).policies).toHaveLength(2);
    expect(ins(g).policies[1]).toMatchObject({ propertyKeys: ['MUMBAI', 'AGRA'], payoutLimit: BILL, pricing: { portfolioPercent: 5, premium: 475 } });
    expect(uninsuredProperties(g.state, g.id('Asha'))).toEqual([]);
    expect(insureAllBlocker(g.state, g.id('Asha'), [])).toBe('Every property you own is already insured.');
  });

  it('in a later year it charges that year’s quote', () => {
    const g = owning();
    setClock(g, COVER + 10);
    scheduleFrom(g, gameClock(eco(g)));
    expect(refusal(() => insureAll(g, 'Asha', [...KEYS], 675)).code).toBe('STALE_STATE');
    insureAll(g, 'Asha', [...KEYS]);
    expect(g.balance('Asha')).toBe(START_CASH - 810); // 3 × 300 less 10%
  });

  it('is all or nothing: short of the total, a property not owned, or one already insured changes nothing', () => {
    const g = owning();
    leaveWith(g, 'Asha', 674, 'Bilal');
    const short = refusal(() => insureAll(g, 'Asha', [...KEYS]));
    expect(short).toEqual({ code: 'INSUFFICIENT_FUNDS', message: 'Not enough money — insuring 3 properties costs ₹675.' });
    expect(ins(g).policies).toEqual([]);
    expect(g.balance('Asha')).toBe(674);

    g.give('Bilal', 'MADRAS');
    expect(refusal(() => insureAll(g, 'Asha', ['MUMBAI', 'MADRAS'])).code).toBe('NOT_OWNER');
    insure(g, 'Asha', 'MUMBAI');
    expect(refusal(() => insureAll(g, 'Asha', ['DELHI', 'MUMBAI'])).message).toBe('Mumbai is already insured — 36 spaces of cover left.');
    expect(refusal(() => insureAll(g, 'Asha', ['DELHI', 'DELHI'])).code).toBe('INSURANCE_NOT_ALLOWED');
    expect(ins(g).policies).toHaveLength(1);
    expect(g.balance('Asha')).toBe(674 - P1);
  });

  it('is refused in a Classic game and while a crisis bill is open', () => {
    const c = new TestGame(['Asha', 'Bilal']);
    c.give('Asha', 'MUMBAI');
    expect(refusal(() => c.act('Asha', { type: 'INSURE_PROPERTIES', propertyKeys: ['MUMBAI'], expectedPremium: P1 })).code).toBe('INSURANCE_NOT_ALLOWED');
    const g = owning();
    rollTo(g, FIRST, 'MUMBAI');
    expect(refusal(() => insureAll(g, 'Asha', [...KEYS])).code).toBe('INVALID_PHASE');
  });
});

describe('ownership changes', () => {
  it('a traded property leaves the seller’s policy for good; the buyer gets no cover; the trade is final', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const p = ins(g).policies[0]!;
    const r = tradeAway(g, 'Asha', 'Bilal', ['MUMBAI']);
    expect(types(r)).toContain('INSURANCE_ENDED');
    expect(policy(g, p.id)).toMatchObject({ status: 'ENDED', propertyKeys: [], boughtKeys: ['MUMBAI'], claimedTotal: 0 });
    expect(policy(g, p.id).closedAt).not.toBeNull();
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(propertyInsurance(g.state, 'MUMBAI')).toMatchObject({ active: null, latest: null });
    // An undo could give the property back but not the cover, so the trade can no longer be undone.
    expect(g.state.undoStack.some((u) => u.actionType === 'ACCEPT_TRADE')).toBe(false);
    // The crisis strikes the new owner, uninsured; the old owner can claim nothing.
    rollTo(g, FIRST);
    expect(crisisAt(g, 1)).toMatchObject({ ownerId: g.id('Bilal'), status: 'PENDING', policyId: null });
    pay(g, 'Bilal');
    // Bought back, it is still not covered: the policy does not revive.
    tradeAway(g, 'Bilal', 'Asha', ['MUMBAI']);
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('a trade of uninsured property stays undoable as before', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    tradeAway(g, 'Asha', 'Bilal', ['MUMBAI']);
    expect(g.state.undoStack.some((u) => u.actionType === 'ACCEPT_TRADE')).toBe(true);
  });

  it('a portfolio keeps covering what is left, with its claims and remaining limit unchanged', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'DELHI');
    insureAll(g, 'Asha', ['MUMBAI', 'DELHI']);
    const p = ins(g).policies[0]!;
    // Surgery: a period long enough for two crises, so the remaining limit matters.
    p.expiryClock = SECOND + 10;
    p.payoutLimit = 4000;
    advance(g, FIRST, 'MUMBAI');
    expect(policy(g, p.id).claimedTotal).toBe(BILL);
    tradeAway(g, 'Asha', 'Bilal', ['MUMBAI']);
    expect(policy(g, p.id)).toMatchObject({ status: 'ACTIVE', propertyKeys: ['DELHI'], boughtKeys: ['MUMBAI', 'DELHI'], claimedTotal: BILL, payoutLimit: 4000 });
    expect(activePolicyFor(g.state, 'DELHI')!.id).toBe(p.id);
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    // DELHI is struck: only the ₹1,000 left is paid.
    if (g.state.turn.phase === 'TURN_COMPLETE') g.act(g.current, { type: 'END_TURN' });
    rollTo(g, SECOND, 'DELHI');
    expect(crisisAt(g, 2)).toMatchObject({ propertyKey: 'DELHI', covered: 1000, status: 'PENDING' });
    expect(crisisDue(crisisAt(g, 2))).toBe(2000);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('selling an insured property to the bank ends its cover, with no refund, and the sale is final', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const r = g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => t.type)).toEqual(['PROPERTY_SALE']);
    expect(ins(g).policies[0]).toMatchObject({ status: 'ENDED', propertyKeys: [] });
    expect(g.state.undoStack.some((u) => u.actionType === 'SELL_PROPERTY')).toBe(false);
  });
});

describe('cancellation and repurchase', () => {
  it('there is no cancellation: no action exists for it, and a running policy can’t be bought over', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    expect(() => g.act('Asha', { type: 'CANCEL_INSURANCE', policyId: ins(g).policies[0]!.id } as unknown as GameAction)).toThrow();
    expect(refusal(() => insure(g, 'Asha', 'MUMBAI')).message).toContain('Already insured');
    expect(ins(g).policies).toHaveLength(1);
    expect(g.balance('Asha')).toBe(START_CASH - P1);
  });

  it('selling and buying back gives no fresh limit for free and recreates no discount', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const first = ins(g).policies[0]!;
    tradeAway(g, 'Asha', 'Bilal', ['MUMBAI']);
    tradeAway(g, 'Bilal', 'Asha', ['MUMBAI']);
    // Insuring it again is a new purchase at full price, a new renewal line, no history carried over or erased.
    insure(g, 'Asha', 'MUMBAI');
    const second = ins(g).policies[1]!;
    expect(second).toMatchObject({ renewalOf: null, noClaimPeriods: 0, premiumPaid: P1, claimedTotal: 0 });
    expect(policy(g, first.id)).toMatchObject({ status: 'ENDED', claimedTotal: 0 });
    expect(g.ledger.filter((t) => t.type === 'INSURANCE_PREMIUM').map((t) => t.amount)).toEqual([P1, P1]);
    expect(renewalBlocker(g.state, g.id('Asha'), first.id)).toBe('This policy no longer insures any property.');
  });
});

describe('the end of the game, bankruptcy and departure', () => {
  it('the game ending closes every policy: no refund, no payout, and net worth counts only real cash', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const cash = g.balance('Asha');
    const r = g.act('Bilal', { type: 'LEAVE_GAME' });
    expect(g.state.status).toBe('FINISHED');
    expect(ins(g).policies[0]).toMatchObject({ status: 'EXPIRED', claimedTotal: 0 });
    expect(r.transactions.filter((t) => t.toPlayerId === g.id('Asha'))).toEqual([]);
    expect(g.balance('Asha')).toBe(cash);
    expect(netWorth(g.state, g.id('Asha'))).toBe(cash + eco(g).market.MUMBAI.value);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('a covered crisis counts once: the bill paid by insurance is not owed, and nothing extra is added', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    advance(g, FIRST);
    const cash = g.balance('Asha');
    expect(financialOverview(g.state, g.id('Asha'))!.crisisOwed).toBe(0);
    g.act('Bilal', { type: 'LEAVE_GAME' });
    expect(netWorth(g.state, g.id('Asha'))).toBe(cash + eco(g).market.MUMBAI.value);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'COVERED', covered: BILL, paid: 0 });
  });

  it('a player who leaves: their policies end with their estate, and claims already paid stay recorded', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Chitra', 'MUMBAI');
    insure(g, 'Chitra', 'MUMBAI');
    advance(g, 54);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'COVERED', ownerId: g.id('Chitra') });
    g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(ins(g).policies[0]).toMatchObject({ status: 'ENDED', propertyKeys: [], claimedTotal: BILL });
    expect(crisisAt(g, 1)).toMatchObject({ status: 'COVERED', covered: BILL });
    expect(g.ledger.filter((t) => t.type === 'INSURANCE_PREMIUM')).toHaveLength(1);
    expect(stateViolations(g.state, g.ledger)).toEqual([]);
  });

  it('bankruptcy over a partly covered bill: the estate pays only the uncovered part', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'DELHI', { houses: 3 });
    borrow(g, 'Asha', 'SECURED', 10000, ['DELHI']);
    borrow(g, 'Asha', 'PERSONAL', 10000);
    insure(g, 'Asha', 'DELHI');
    const p = ins(g).policies[0]!;
    policy(g, p.id).claimedTotal = 0;
    p.payoutLimit = 3000;
    // Surgery: only ₹1,000 of cover left (as if an earlier claim in the period had used the rest).
    eco(g).insurance!.crises.push({
      id: 'earlier', type: 'PROPERTY_CRISIS', checkpoint: 99, checkpointClock: 1, year: 1, propertyKey: 'DELHI', ownerId: g.id('Asha'), mortgaged: false,
      amount: 2000, covered: 2000, paid: 0, policyId: p.id, status: 'COVERED', createdAt: g.ctx().now, settledAt: g.ctx().now,
    });
    policy(g, p.id).claimedTotal = 2000;
    leaveWith(g, 'Asha', 100, 'Chitra');
    rollTo(g, crisisCheckpointClock(eco(g), 1));
    const crisis = crisisAt(g, 1);
    expect(crisis).toMatchObject({ covered: 1000, status: 'PENDING' });
    const r = g.act('Asha', { type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisis.id });
    expect(r.transactions.filter((t) => t.type === 'CRISIS_PAYMENT').map((t) => t.amount)).toEqual([2000]);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', covered: 1000, paid: 2000 });
    expect(policy(g, p.id)).toMatchObject({ status: 'ENDED', claimedTotal: 3000 });
  });
});

describe('policies stored before the redesign', () => {
  const legacy = () =>
    ({
      policies: [
        { id: 'p1', propertyKey: 'MUMBAI', ownerId: 'a', purchaseYear: 1, premiumPaid: 500, startClock: 0, expiryClock: 72, status: 'CLAIMED', claimedCrisisId: 'c1', createdAt: 't', closedAt: 't' },
        { id: 'p2', propertyKey: 'DELHI', ownerId: 'a', purchaseYear: 2, premiumPaid: 600, startClock: 80, expiryClock: 152, status: 'ACTIVE', claimedCrisisId: null, createdAt: 't', closedAt: null },
      ],
      crises: [
        { id: 'c1', checkpoint: 1, checkpointClock: 36, year: 1, propertyKey: 'MUMBAI', ownerId: 'a', mortgaged: false, amount: 3000, paid: 0, policyId: 'p1', status: 'COVERED', createdAt: 't', settledAt: 't' },
        { id: 'c2', checkpoint: 2, checkpointClock: 108, year: 2, propertyKey: 'AGRA', ownerId: 'a', mortgaged: false, amount: 3000, paid: 3000, policyId: null, status: 'PAID', createdAt: 't', settledAt: 't' },
      ],
      nextCheckpoint: 3,
    }) as unknown as InsuranceState;

  it('are brought into today’s shape with the values the migration backfills, once', () => {
    const upgraded = upgradeInsurance(legacy());
    expect(upgraded.policies[0]).toMatchObject({ propertyKeys: [], boughtKeys: ['MUMBAI'], payoutLimit: 3000, claimedTotal: 3000, entryYear: 1, renewalOf: null, status: 'CLAIMED' });
    expect(upgraded.policies[1]).toMatchObject({ propertyKeys: ['DELHI'], boughtKeys: ['DELHI'], payoutLimit: 3000, claimedTotal: 0, entryYear: 2, status: 'ACTIVE' });
    expect((upgraded.policies[1] as InsurancePolicy & { propertyKey?: string }).propertyKey).toBeUndefined();
    expect(upgraded.crises.map((c) => c.covered)).toEqual([3000, 0]);
    expect(upgradeInsurance(JSON.parse(JSON.stringify(upgraded)))).toEqual(upgraded);
  });

  it('a running one keeps covering its property under the new rules', () => {
    const g = newGame();
    g.give('Asha', 'DELHI');
    const old = legacy();
    const p = { ...old.policies[1]!, ownerId: g.id('Asha'), startClock: 0, expiryClock: COVER } as unknown as InsurancePolicy;
    ins(g).policies.push(p);
    upgradeInsurance(ins(g));
    rollTo(g, FIRST);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'COVERED', policyId: 'p2' });
    expect(ins(g).policies[0]!.claimedTotal).toBe(BILL);
  });
});
