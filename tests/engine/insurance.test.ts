import { describe, expect, it } from 'vitest';
import {
  activePolicyFor,
  averageSpaces,
  BOARD_SIZE,
  crisisBankruptcyBlocker,
  crisisCheckpointClock,
  crisisRecoveryOptions,
  financialOverview,
  gameClock,
  GameError,
  INTERMEDIATE_RULES,
  insureAllBlocker,
  insureBlocker,
  netWorth,
  offeredRate,
  pendingCrises,
  pendingCrisisOf,
  policyStanding,
  premiumForYear,
  PROPERTY_KEYS,
  propertyInsurance,
  uninsuredProperties,
  unmortgageCost,
  yearAt,
  type EngineResult,
  type GameAction,
  type InsuranceState,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';

const INS = INTERMEDIATE_RULES.insurance;
const START_CASH = 25000;
const START_REWARD = 1500;
const BILL = 3000;
/** Two starting players: 36 spaces of average movement = 72 on the shared clock; the first crisis is at 36. */
const COVER = 72;
const FIRST = 36;
const SECOND = 108;

const newGame = (names = ['Asha', 'Bilal']) => new TestGame(names, { mode: 'intermediate' });
const eco = (g: TestGame): IntermediateState => g.state.intermediate!;
const ins = (g: TestGame): InsuranceState => eco(g).insurance!;
const types = (r: EngineResult) => r.events.map((e) => e.type);
const crisisAt = (g: TestGame, checkpoint: number) => ins(g).crises.find((c) => c.checkpoint === checkpoint)!;

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

const insure = (g: TestGame, name: string, propertyKey: PropertyKey) =>
  g.act(name, { type: 'INSURE_PROPERTY', propertyKey, expectedPremium: premiumForYear(eco(g).year) });

const pay = (g: TestGame, name: string, crisisId = pendingCrisisOf(g.state, g.id(name))!.id) => g.act(name, { type: 'PAY_CRISIS_BILL', crisisId });

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number, collateralKey?: PropertyKey) {
  const expectedRatePercent = offeredRate(product, eco(g).credit[g.id(name)]!).ratePercent;
  g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKey ? { collateralKey } : {}) });
}

/** Leaves `name` with exactly `keep` in cash by paying the rest to another player (through the ledger). */
function leaveWith(g: TestGame, name: string, keep: number, to: string) {
  const amount = g.balance(name) - keep;
  if (amount > 0) g.act(name, { type: 'TRANSFER_MONEY', toPlayerId: g.id(to), amount });
}

// ---------------------------------------------------------------------------

describe('premiums', () => {
  it('₹500 in Year 1, +₹100 a year, capped at ₹900', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(premiumForYear)).toEqual([500, 600, 700, 800, 900, 900, 900]);
    expect(INS).toMatchObject({ premiumYear1: 500, premiumStepPerYear: 100, premiumMax: 900, coverageSpaces: 36, crisisBill: 3000, firstCrisisSpaces: 18, crisisIntervalSpaces: 36 });
  });

  it('is charged once, per property, at the price of the financial year of purchase', () => {
    const g = newGame();
    for (const key of ['MUMBAI', 'DELHI', 'AGRA'] as const) g.give('Asha', key);
    const first = insure(g, 'Asha', 'MUMBAI');
    expect(first.transactions).toMatchObject([{ type: 'INSURANCE_PREMIUM', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 500, propertyKey: 'MUMBAI' }]);
    insure(g, 'Asha', 'DELHI');
    insure(g, 'Asha', 'AGRA');
    // Three properties in Year 1: ₹1,500 in total.
    expect(g.balance('Asha')).toBe(START_CASH - 1500);
    expect(ins(g).policies.map((p) => [p.propertyKey, p.premiumPaid, p.purchaseYear])).toEqual([
      ['MUMBAI', 500, 1],
      ['DELHI', 500, 1],
      ['AGRA', 500, 1],
    ]);
  });

  it('three properties in Year 4 cost ₹2,400', () => {
    const g = newGame();
    for (const key of ['MUMBAI', 'DELHI', 'AGRA'] as const) g.give('Asha', key);
    setClock(g, 3 * COVER + 10);
    scheduleFrom(g, gameClock(eco(g)));
    expect(eco(g).year).toBe(4);
    for (const key of ['MUMBAI', 'DELHI', 'AGRA'] as const) insure(g, 'Asha', key);
    expect(g.balance('Asha')).toBe(START_CASH - 2400);
    expect(ins(g).policies.every((p) => p.premiumPaid === 800 && p.purchaseYear === 4)).toBe(true);
  });

  it('the server sets the price: a confirmation for another price is refused and nothing is charged', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    const r = refusal(() => g.act('Asha', { type: 'INSURE_PROPERTY', propertyKey: 'MUMBAI', expectedPremium: 100 }));
    expect(r.code).toBe('STALE_STATE');
    expect(r.message).toContain('₹500');
    expect(g.balance('Asha')).toBe(START_CASH);
    expect(ins(g).policies).toEqual([]);
  });

  it('without the cash the purchase is refused: no deduction, no policy', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    leaveWith(g, 'Asha', 499, 'Bilal');
    expect(insureBlocker(g.state, g.id('Asha'), 'MUMBAI')).toBe('Not enough money — the premium is ₹500.');
    expect(refusal(() => insure(g, 'Asha', 'MUMBAI')).code).toBe('INSUFFICIENT_FUNDS');
    expect(g.balance('Asha')).toBe(499);
    expect(ins(g).policies).toEqual([]);
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
    expect(g.balance('Asha')).toBe(START_CASH - 500);
    expect(ins(g).policies).toHaveLength(1);
  });
});

describe('policy duration', () => {
  it('starts at once and runs for 36 spaces of average movement from the purchase point', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    setClock(g, 10);
    insure(g, 'Asha', 'MUMBAI');
    const policy = ins(g).policies[0]!;
    expect(policy).toMatchObject({ ownerId: g.id('Asha'), propertyKey: 'MUMBAI', startClock: 10, expiryClock: 10 + COVER, status: 'ACTIVE', claimedCrisisId: null });
    expect(activePolicyFor(g.state, 'MUMBAI')?.id).toBe(policy.id);
    expect(averageSpaces(eco(g), policy.expiryClock) - averageSpaces(eco(g), policy.startClock)).toBe(36);
  });

  it('with three starting players 36 average spaces are 108 on the shared clock', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    expect(ins(g).policies[0]).toMatchObject({ startClock: 0, expiryClock: 108 });
  });

  it('cover ends exactly at the expiry point; an unused policy expires with no refund', () => {
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
    expect(ins(g).policies[0]).toMatchObject({ status: 'EXPIRED', claimedCrisisId: null });
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(policyStanding(g.state, ins(g).policies[0]!)).toBe('EXPIRED');
    expect(g.balance('Asha')).toBe(cash);
  });

  it('an expired policy can be bought again, at the price of the year it is bought in', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    scheduleFrom(g, 1000);
    rollTo(g, COVER + 5);
    expect(eco(g).year).toBe(2);
    expect(propertyInsurance(g.state, 'MUMBAI')).toMatchObject({ active: null, premium: 600, year: 2 });
    g.act(g.current, { type: 'END_TURN' });
    insure(g, 'Asha', 'MUMBAI');
    expect(ins(g).policies.map((p) => [p.status, p.premiumPaid])).toEqual([
      ['EXPIRED', 500],
      ['ACTIVE', 600],
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

describe('what insurance covers', () => {
  it('an insured property: the bill is waived, the policy is spent, no cash moves and play carries on', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    const cash = { Asha: g.balance('Asha'), Bilal: g.balance('Bilal') };
    const roller = g.current;
    const r = rollTo(g, FIRST);
    const crisis = crisisAt(g, 1);
    expect(crisis).toMatchObject({ status: 'COVERED', amount: BILL, paid: 0, policyId: ins(g).policies[0]!.id });
    expect(ins(g).policies[0]).toMatchObject({ status: 'CLAIMED', claimedCrisisId: crisis.id });
    expect(r.transactions.map((t) => t.type)).toEqual(['START_REWARD']);
    expect(g.balance('Asha')).toBe(cash.Asha + (roller === 'Asha' ? START_REWARD : 0));
    expect(pendingCrises(g.state)).toEqual([]);
    g.act(roller, { type: 'END_TURN' });
  });

  it('a policy covers one crisis only: the same property struck again is uninsured', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    rollTo(g, FIRST);
    expect(crisisAt(g, 1).status).toBe('COVERED');
    g.act(g.current, { type: 'END_TURN' });
    // Even if its term reached past the next checkpoint (test surgery), a used policy protects nothing.
    ins(g).policies[0]!.expiryClock = SECOND + COVER;
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(policyStanding(g.state, ins(g).policies[0]!)).toBe('CLAIMED');
    rollTo(g, SECOND);
    expect(crisisAt(g, 2)).toMatchObject({ propertyKey: 'MUMBAI', status: 'PENDING', policyId: null, amount: BILL });
  });

  it('a policy that expires at the checkpoint does not cover it; one that ends just after does', () => {
    const expired = newGame();
    expired.give('Asha', 'MUMBAI');
    setClock(expired, SECOND - COVER);
    scheduleFrom(expired, SECOND - COVER);
    insure(expired, 'Asha', 'MUMBAI');
    expect(ins(expired).policies[0]!.expiryClock).toBe(SECOND);
    const r = rollTo(expired, SECOND);
    expect(crisisAt(expired, 2)).toMatchObject({ status: 'PENDING', policyId: null });
    expect(ins(expired).policies[0]).toMatchObject({ status: 'EXPIRED', claimedCrisisId: null });
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
    expect(ins(g).policies[0]!.status).toBe('CLAIMED');
  });

  it('insurance bought after a crisis was selected never covers it', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    rollTo(g, FIRST);
    const crisis = crisisAt(g, 1);
    expect(crisis.status).toBe('PENDING');
    // Not while the bill is open…
    expect(refusal(() => insure(g, 'Asha', 'MUMBAI')).code).toBe('INVALID_PHASE');
    expect(ins(g).policies).toEqual([]);
    // …and a policy bought once it is paid leaves that bill paid.
    const before = g.balance('Asha');
    pay(g, 'Asha');
    insure(g, 'Asha', 'MUMBAI');
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL, policyId: null });
    expect(g.balance('Asha')).toBe(before - BILL - 500);
    expect(ins(g).policies[0]).toMatchObject({ status: 'ACTIVE', startClock: FIRST });
  });

  it('a policy does not travel with the property: it protects its buyer only', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    insure(g, 'Asha', 'MUMBAI');
    g.give('Bilal', 'MUMBAI');
    expect(activePolicyFor(g.state, 'MUMBAI')).toBeNull();
    expect(policyStanding(g.state, ins(g).policies[0]!)).toBe('NOT_OWNED');
    expect(propertyInsurance(g.state, 'MUMBAI')).toMatchObject({ active: null, latest: null });
    rollTo(g, FIRST);
    expect(crisisAt(g, 1)).toMatchObject({ ownerId: g.id('Bilal'), status: 'PENDING' });
    expect(ins(g).policies[0]).toMatchObject({ status: 'ACTIVE', claimedCrisisId: null });
    // Back with its buyer before it runs out, it protects again.
    pay(g, 'Bilal');
    g.give('Asha', 'MUMBAI');
    expect(activePolicyFor(g.state, 'MUMBAI')?.ownerId).toBe(g.id('Asha'));
  });
});

describe('mortgaged properties', () => {
  it('insured and mortgaged: the bill is waived and the mortgage, buildings and owner are untouched', () => {
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
    expect(crisisRecoveryOptions(g.state, g.id('Asha'))).toEqual(['mortgage a property', 'sell a property to the bank', 'take a loan']);
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
    expect(bankrupt.message).toContain('You can still raise money: mortgage a property, sell a property to the bank, take a loan.');
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
    expect(crisisRecoveryOptions(g.state, g.id('Asha'))).toEqual(['sell a building', 'mortgage a property', 'sell a property to the bank', 'take a loan']);
    g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    borrow(g, 'Asha', 'EMERGENCY', 1000);
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
   * property (Delhi) is pledged to a loan, so it can be neither mortgaged nor sold.
   */
  function exhausted(names: string[]) {
    const g = newGame(names);
    g.give('Asha', 'DELHI');
    borrow(g, 'Asha', 'SECURED', 1000, 'DELHI');
    borrow(g, 'Asha', 'PERSONAL', 10000);
    borrow(g, 'Asha', 'LONG_TERM', 9000);
    return g;
  }

  it('is allowed only once nothing is left to try; then the game’s own bankruptcy runs', () => {
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
    expect(r.transactions).toMatchObject([{ type: 'BANKRUPTCY_SETTLEMENT', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 100 + START_REWARD }]);
    expect(g.player('Asha')).toMatchObject({ status: 'BANKRUPT', balance: 0 });
    expect(g.state.properties.DELHI).toMatchObject({ ownerId: null, mortgaged: false });
    expect(eco(g).loans.every((l) => l.status === 'WRITTEN_OFF')).toBe(true);
    expect(crisisAt(g, 1)).toMatchObject({ status: 'BANKRUPT', paid: 100 + START_REWARD });
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
  it('ending the game collects the bill before the winner is decided', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    rollTo(g, FIRST);
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'END_GAME' });
    expect(types(r).indexOf('CRISIS_SETTLED')).toBeGreaterThanOrEqual(0);
    expect(types(r).indexOf('CRISIS_SETTLED')).toBeLessThan(types(r).indexOf('GAME_FINISHED'));
    expect(crisisAt(g, 1)).toMatchObject({ status: 'PAID', paid: BILL });
    expect(g.balance('Asha')).toBe(cash - BILL);
    const standings = r.events.find((e) => e.type === 'GAME_FINISHED')!.payload.standings as { playerId: string; netWorth: number }[];
    expect(standings.find((s) => s.playerId === g.id('Asha'))!.netWorth).toBe(cash - BILL + eco(g).market.MUMBAI.value);
  });

  it('a bill that can’t be collected in full still counts against the final net worth', () => {
    const g = newGame();
    g.give('Asha', 'MUMBAI');
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    leaveWith(g, 'Asha', 400, 'Bilal');
    rollTo(g, FIRST);
    const r = g.act('Asha', { type: 'END_GAME' });
    expect(crisisAt(g, 1)).toMatchObject({ status: 'UNPAID', paid: 400 });
    expect(types(r)).toContain('CRISIS_UNPAID');
    expect(g.balance('Asha')).toBe(0);
    expect(netWorth(g.state, g.id('Asha'))).toBe(eco(g).market.MUMBAI.value - (BILL - 400));
    expect(g.state.winnerId).toBe(g.id('Bilal'));
  });

  it('leaving does not dodge the bill and does not leave the table waiting', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    rollTo(g, 10);
    g.act('Asha', { type: 'END_TURN' });
    rollTo(g, crisisCheckpointClock(eco(g), 1));
    const cash = g.balance('Asha');
    const r = g.act('Asha', { type: 'LEAVE_GAME' });
    expect(r.transactions).toMatchObject([{ type: 'CRISIS_PAYMENT', amount: BILL }]);
    expect(g.player('Asha')).toMatchObject({ status: 'LEFT', balance: cash - BILL });
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
      message: 'Property insurance is only available in Intermediate Mode.',
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
    const r = g.act('Asha', { type: 'BUY_PROPERTY', insurePremium: 500 });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['PROPERTY_PURCHASE', price],
      ['INSURANCE_PREMIUM', 500],
    ]);
    expect(types(r)).toEqual(['PROPERTY_PURCHASED', 'INSURANCE_PURCHASED']);
    expect(g.balance('Asha')).toBe(cash - price - 500);
    expect(g.state.properties.AGRA.ownerId).toBe(g.id('Asha'));
    expect(g.state.turn).toMatchObject({ phase: 'TURN_COMPLETE', pending: null });
    expect(activePolicyFor(g.state, 'AGRA')).toMatchObject({ ownerId: g.id('Asha'), premiumPaid: 500, status: 'ACTIVE' });
  });

  it('if the policy can’t be bought, the property isn’t either', () => {
    const stale = landed();
    const before = JSON.stringify(stale.state);
    expect(refusal(() => stale.act('Asha', { type: 'BUY_PROPERTY', insurePremium: 400 })).code).toBe('STALE_STATE');
    expect(JSON.stringify(stale.state)).toBe(before);

    const g = landed();
    const price = (g.state.turn.pending as { price: number }).price;
    leaveWith(g, 'Asha', price + 499, 'Bilal');
    expect(refusal(() => g.act('Asha', { type: 'BUY_PROPERTY', insurePremium: 500 })).code).toBe('INSUFFICIENT_FUNDS');
    expect(g.state.properties.AGRA.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(price + 499);
    // The plain purchase is still there.
    g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(g.state.properties.AGRA.ownerId).toBe(g.id('Asha'));
    expect(ins(g).policies).toEqual([]);
  });

  it('a Classic game refuses it and keeps its plain purchase', () => {
    const g = landed('classic');
    const cash = g.balance('Asha');
    expect(refusal(() => g.act('Asha', { type: 'BUY_PROPERTY', insurePremium: 500 })).code).toBe('INSURANCE_NOT_ALLOWED');
    expect(g.state.properties.AGRA.ownerId).toBeNull();
    expect(g.balance('Asha')).toBe(cash);
    const r = g.act('Asha', { type: 'BUY_PROPERTY' });
    expect(r.transactions.map((t) => t.type)).toEqual(['PROPERTY_PURCHASE']);
  });
});

describe('insure all', () => {
  const KEYS = ['MUMBAI', 'DELHI', 'AGRA'] as const;
  function owning() {
    const g = newGame();
    for (const key of KEYS) g.give('Asha', key);
    return g;
  }
  const insureAll = (g: TestGame, name: string, propertyKeys: PropertyKey[], expectedPremium = premiumForYear(eco(g).year)) =>
    g.act(name, { type: 'INSURE_PROPERTIES', propertyKeys, expectedPremium });

  it('one action insures every uninsured property: one policy and one premium each', () => {
    const g = owning();
    insure(g, 'Asha', 'DELHI');
    expect(uninsuredProperties(g.state, g.id('Asha')).sort()).toEqual(['AGRA', 'MUMBAI']);
    const r = insureAll(g, 'Asha', uninsuredProperties(g.state, g.id('Asha')));
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['INSURANCE_PREMIUM', 500],
      ['INSURANCE_PREMIUM', 500],
    ]);
    expect(g.balance('Asha')).toBe(START_CASH - 1500);
    expect(ins(g).policies).toHaveLength(3);
    expect(uninsuredProperties(g.state, g.id('Asha'))).toEqual([]);
    expect(insureAllBlocker(g.state, g.id('Asha'), [])).toBe('Every property you own is already insured.');
  });

  it('in a later year it charges that year’s premium for each', () => {
    const g = owning();
    setClock(g, COVER + 10);
    scheduleFrom(g, gameClock(eco(g)));
    expect(refusal(() => insureAll(g, 'Asha', [...KEYS], 500)).code).toBe('STALE_STATE');
    insureAll(g, 'Asha', [...KEYS]);
    expect(g.balance('Asha')).toBe(START_CASH - 3 * 600);
  });

  it('is all or nothing: short of the total, a property not owned, or one already insured changes nothing', () => {
    const g = owning();
    leaveWith(g, 'Asha', 1400, 'Bilal');
    const short = refusal(() => insureAll(g, 'Asha', [...KEYS]));
    expect(short).toEqual({ code: 'INSUFFICIENT_FUNDS', message: 'Not enough money — insuring 3 properties costs ₹1,500.' });
    expect(ins(g).policies).toEqual([]);
    expect(g.balance('Asha')).toBe(1400);

    g.give('Bilal', 'MADRAS');
    expect(refusal(() => insureAll(g, 'Asha', ['MUMBAI', 'MADRAS'])).code).toBe('NOT_OWNER');
    insure(g, 'Asha', 'MUMBAI');
    expect(refusal(() => insureAll(g, 'Asha', ['DELHI', 'MUMBAI'])).message).toBe('Mumbai is already insured.');
    expect(refusal(() => insureAll(g, 'Asha', ['DELHI', 'DELHI'])).code).toBe('INSURANCE_NOT_ALLOWED');
    expect(ins(g).policies).toHaveLength(1);
    expect(g.balance('Asha')).toBe(900);
  });

  it('is refused in a Classic game and while a crisis bill is open', () => {
    const c = new TestGame(['Asha', 'Bilal']);
    c.give('Asha', 'MUMBAI');
    expect(refusal(() => c.act('Asha', { type: 'INSURE_PROPERTIES', propertyKeys: ['MUMBAI'], expectedPremium: 500 })).code).toBe('INSURANCE_NOT_ALLOWED');
    const g = owning();
    rollTo(g, FIRST, 'MUMBAI');
    expect(refusal(() => insureAll(g, 'Asha', [...KEYS])).code).toBe('INVALID_PHASE');
  });
});
