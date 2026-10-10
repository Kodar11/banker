import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE,
  completedTradeCount,
  dealObjectives,
  GameError,
  gameClock,
  getDeed,
  netWorth,
  OBJECTIVE_IDS,
  OBJECTIVES,
  objectiveTerms,
  objectiveView,
  offeredRate,
  redactObjectives,
  scaleToStartingCash,
  type EngineResult,
  type IntermediateState,
  type LoanProductKey,
  type ObjectiveId,
  type ObjectiveResult,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';

/** Two starting players: one financial year = 72 spaces on the shared clock; the payment window is a quarter of it. */
const YEAR = 72;
const WINDOW = 18;

const newGame = (names = ['Asha', 'Bilal'], config?: unknown) => new TestGame(names, { mode: 'intermediate', config });
const eco = (g: TestGame): IntermediateState => g.state.intermediate!;

/** Test surgery: gives each named player a chosen objective (the deal itself is tested separately). */
function assign(g: TestGame, objectives: Record<string, ObjectiveId>): void {
  for (const [name, id] of Object.entries(objectives)) g.state.objectives!.assignments[g.id(name)] = id;
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

/** The current player rolls 2, lands exactly on Start and ends the turn. */
function tick(g: TestGame) {
  const name = g.current;
  g.placeAt(name, BOARD_SIZE - 2);
  g.queueRandom(faceToRandom(1), faceToRandom(1));
  const result = g.act(name, { type: 'ROLL_DICE' });
  g.act(name, { type: 'END_TURN' });
  return result;
}

/** Puts the shared clock at `target` with one roll of 2 (test surgery on the stored movement). */
function jumpTo(g: TestGame, target: number) {
  const movement = eco(g).movement;
  const ids = Object.keys(movement);
  for (const id of ids) movement[id] = 0;
  movement[ids[0]!] = target - 2;
  tick(g);
  expect(gameClock(eco(g))).toBe(target);
}

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number) {
  const expectedRatePercent = offeredRate(product, eco(g).credit[g.id(name)]!).ratePercent;
  g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent });
}

/** Both players make and accept one property trade. Returns the accepting action's result. */
function trade(g: TestGame, from: string, to: string, key: PropertyKey, actionId?: string): EngineResult {
  g.act(from, { type: 'CREATE_TRADE', toPlayerId: g.id(to), offeredPropertyKeys: [key], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 });
  const offer = g.state.trades.filter((t) => t.status === 'PENDING').at(-1)!;
  return g.act(to, { type: 'ACCEPT_TRADE', tradeId: offer.id }, actionId);
}

const end = (g: TestGame, host = 'Asha') => g.act(host, { type: 'END_GAME' });
const resultOf = (g: TestGame, name: string): ObjectiveResult => g.state.objectives!.results!.find((r) => r.playerId === g.id(name))!;
const rewards = (g: TestGame) => g.ledger.filter((t) => t.type === 'OBJECTIVE_REWARD');

// ---------------------------------------------------------------------------

describe('the objective registry', () => {
  it('holds the four agreed objectives with their base rewards and targets', () => {
    expect(OBJECTIVE_IDS).toEqual(['PROPERTY_MOGUL', 'BUILDER', 'CASH_GUARDIAN', 'DEAL_MAKER']);
    expect(OBJECTIVE_IDS.map((id) => [OBJECTIVES[id].id, OBJECTIVES[id].name, OBJECTIVES[id].baseReward, OBJECTIVES[id].baseCashTarget])).toEqual([
      ['PROPERTY_MOGUL', 'Property Mogul', 5000, 12000],
      ['BUILDER', 'The Builder', 4000, null],
      ['CASH_GUARDIAN', 'Cash Guardian', 4000, 12000],
      ['DEAL_MAKER', 'Deal Maker', 4000, null],
    ]);
    expect(OBJECTIVES.DEAL_MAKER.tracks).toBe('COMPLETED_TRADES');
  });
});

describe('rewards and rupee targets scale with starting cash', () => {
  it.each([
    [10000, 1600, 2000],
    [25000, 4000, 5000],
    [40000, 6400, 8000],
    [50000, 8000, 10000],
  ])('starting cash %i: ₹4,000 → %i, ₹5,000 → %i', (startingCash, four, five) => {
    expect(scaleToStartingCash(4000, startingCash)).toBe(four);
    expect(scaleToStartingCash(5000, startingCash)).toBe(five);
    expect(objectiveTerms('BUILDER', startingCash).reward).toBe(four);
    expect(objectiveTerms('DEAL_MAKER', startingCash).reward).toBe(four);
    expect(objectiveTerms('CASH_GUARDIAN', startingCash).reward).toBe(four);
    expect(objectiveTerms('PROPERTY_MOGUL', startingCash).reward).toBe(five);
  });

  it.each([
    [10000, 4800],
    [25000, 12000],
    [50000, 24000],
  ])('starting cash %i: the ₹12,000 targets become %i', (startingCash, target) => {
    expect(objectiveTerms('CASH_GUARDIAN', startingCash).cashTarget).toBe(target);
    expect(objectiveTerms('PROPERTY_MOGUL', startingCash).cashTarget).toBe(target);
  });

  it('quantity goals never scale', () => {
    for (const cash of [10000, 25000, 50000]) {
      expect(objectiveTerms('BUILDER', cash).cashTarget).toBeNull();
      expect(objectiveTerms('DEAL_MAKER', cash).cashTarget).toBeNull();
    }
    expect([OBJECTIVES.PROPERTY_MOGUL.quantity, OBJECTIVES.BUILDER.quantity, OBJECTIVES.DEAL_MAKER.quantity]).toEqual([3, 3, 2]);
  });

  it('rounds once, to the nearest ₹100, half up — in whole numbers', () => {
    expect(scaleToStartingCash(1000, 11000)).toBe(400); // 440
    expect(scaleToStartingCash(1000, 11250)).toBe(500); // 450 → up
    expect(scaleToStartingCash(1000, 11249)).toBe(400); // 449.96
    expect(scaleToStartingCash(4000, 12345)).toBe(2000); // 1975.2
    expect(scaleToStartingCash(5000, 25000)).toBe(5000);
    for (const cash of [10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000]) {
      for (const base of [4000, 5000, 12000]) {
        const scaled = scaleToStartingCash(base, cash);
        expect(scaled).toBe((base * cash) / 25000);
        expect(Number.isInteger(scaled) && scaled % 100 === 0).toBe(true);
      }
    }
  });
});

describe('dealing', () => {
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it.each([2, 3, 4])('%i players get distinct objectives', (players) => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const dealt = dealObjectives(players, lcg(seed));
      expect(dealt).toHaveLength(players);
      expect(new Set(dealt).size).toBe(players);
    }
  });

  it.each([5, 6, 7, 8])('%i players: every objective is in play before any is repeated', (players) => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const dealt = dealObjectives(players, lcg(seed));
      expect(dealt).toHaveLength(players);
      expect(new Set(dealt.slice(0, 4)).size).toBe(4);
      expect(new Set(dealt.slice(4)).size).toBe(players - 4);
      for (const id of dealt) expect(OBJECTIVE_IDS).toContain(id);
    }
  });

  it('is decided by the RNG it is given: same draws, same deal; different draws, a different one', () => {
    expect(dealObjectives(4, lcg(7))).toEqual(dealObjectives(4, lcg(7)));
    const deals = new Set(Array.from({ length: 50 }, (_, i) => dealObjectives(4, lcg(i + 1)).join()));
    expect(deals.size).toBeGreaterThan(10);
  });

  it('an Intermediate game deals one to every starting player at START_GAME, and to nobody before', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev'], { mode: 'intermediate', start: false });
    expect(g.state.objectives).toBeNull();
    g.startWith(['Asha', 'Bilal', 'Chitra', 'Dev']);
    const { assignments, trades, results } = g.state.objectives!;
    expect(Object.keys(assignments).sort()).toEqual(['Asha', 'Bilal', 'Chitra', 'Dev'].map((n) => g.id(n)).sort());
    expect(new Set(Object.values(assignments)).size).toBe(4);
    expect(trades).toEqual([]);
    expect(results).toBeNull();
  });

  it('someone who left the lobby is dealt nothing', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { mode: 'intermediate', start: false });
    g.act('Chitra', { type: 'LEAVE_GAME' });
    g.queueRandom(0.999);
    g.act('Asha', { type: 'START_GAME' });
    expect(Object.keys(g.state.objectives!.assignments).sort()).toEqual([g.id('Asha'), g.id('Bilal')].sort());
  });

  it('eight players: everyone has one, and each objective is held by exactly two', () => {
    const g = new TestGame(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], { mode: 'intermediate' });
    const held = Object.values(g.state.objectives!.assignments);
    expect(held).toHaveLength(8);
    for (const id of OBJECTIVE_IDS) expect(held.filter((h) => h === id)).toHaveLength(2);
  });

  it('none in Classic, none when the host disabled them', () => {
    expect(new TestGame(['Asha', 'Bilal']).state.objectives).toBeNull();
    expect(newGame(['Asha', 'Bilal'], { secretObjectives: false }).state.objectives).toBeNull();
  });

  it('the deal is final: no later action re-deals, swaps or edits it', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    const dealt = structuredClone(g.state.objectives!.assignments);
    for (let i = 0; i < 9; i += 1) tick(g);
    g.act('Asha', { type: 'PAUSE_GAME' });
    g.act('Bilal', { type: 'RESUME_GAME' });
    g.act('Chitra', { type: 'LEAVE_GAME' });
    expect(g.state.objectives!.assignments).toEqual(dealt);
    // Starting again is impossible, so there is no second deal to ask for.
    expect(refusal(() => g.act('Asha', { type: 'START_GAME' })).code).toBe('INVALID_PHASE');
    expect(g.state.objectives!.assignments).toEqual(dealt);
  });
});

describe('secrecy', () => {
  it('a player’s view holds their own objective and nobody else’s — the host included', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    const all = g.state.objectives!.assignments;
    for (const name of ['Asha', 'Bilal', 'Chitra']) {
      const seen = redactObjectives(g.state, g.id(name));
      expect(seen.objectives!.assignments).toEqual({ [g.id(name)]: all[g.id(name)] });
      // Nothing else in the view names another player's objective.
      const others = Object.entries(all).filter(([id]) => id !== g.id(name));
      const json = JSON.stringify({ ...seen, objectives: { ...seen.objectives, assignments: {} } });
      for (const [, objective] of others) expect(json).not.toContain(objective);
    }
    expect(g.player('Asha').isHost).toBe(true);
    expect(Object.keys(redactObjectives(g.state, g.id('Asha')).objectives!.assignments)).toEqual([g.id('Asha')]);
  });

  it('someone who is not a player sees none, and redacting never touches the server’s own state', () => {
    const g = newGame(['Asha', 'Bilal']);
    const before = structuredClone(g.state);
    expect(redactObjectives(g.state, null).objectives!.assignments).toEqual({});
    expect(redactObjectives(g.state, '00000000-0000-4000-8000-ffffffffffff').objectives!.assignments).toEqual({});
    expect(g.state).toEqual(before);
  });

  it('reading the view again and again returns the same objective (a reconnect deals nothing)', () => {
    const g = newGame(['Asha', 'Bilal']);
    const first = redactObjectives(g.state, g.id('Bilal')).objectives!.assignments;
    for (let i = 0; i < 5; i += 1) expect(redactObjectives(g.state, g.id('Bilal')).objectives!.assignments).toEqual(first);
  });

  it('no event, transaction or log line of a running game mentions an objective', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI');
    trade(g, 'Asha', 'Bilal', 'MUMBAI');
    for (let i = 0; i < 6; i += 1) tick(g);
    g.act('Chitra', { type: 'LEAVE_GAME' });
    const published = JSON.stringify(g.results.map((r) => ({ events: r.events, transactions: r.transactions, bids: r.bids })));
    expect(published).not.toMatch(/objective/i);
    for (const id of OBJECTIVE_IDS) {
      expect(published).not.toContain(id);
      expect(published).not.toContain(OBJECTIVES[id].name);
    }
  });

  it('a trade offer says nothing about why it was made', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'DEAL_MAKER' });
    g.give('Asha', 'MUMBAI');
    const r = g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 500 });
    expect(JSON.stringify([r.events, g.state.trades])).not.toMatch(/objective|DEAL_MAKER|Deal Maker/i);
  });

  it('everything is revealed once the game has finished', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    const all = structuredClone(g.state.objectives!.assignments);
    end(g);
    expect(redactObjectives(g.state, g.id('Bilal')).objectives!.assignments).toEqual(all);
    expect(redactObjectives(g.state, null).objectives!.results).toHaveLength(3);
  });

  it('a player’s own view describes their objective with this game’s numbers', () => {
    const g = newGame(['Asha', 'Bilal'], { startingCash: 50000 });
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'PROPERTY_MOGUL' });
    const mine = objectiveView(redactObjectives(g.state, g.id('Asha')), g.id('Asha'))!;
    expect(mine.definition.name).toBe('Cash Guardian');
    expect(mine.terms).toEqual({ reward: 8000, cashTarget: 24000 });
    expect(mine.description).toContain('at least ₹24,000 in cash');
    expect(mine.check).toEqual({ completed: true, progress: '₹50,000 cash (needs ₹24,000)' });
    // Asha's device holds nothing of Bilal's, so it cannot show his.
    expect(objectiveView(redactObjectives(g.state, g.id('Asha')), g.id('Bilal'))).toBeNull();
    expect(objectiveView(new TestGame(['Asha', 'Bilal']).state, g.id('Asha'))).toBeNull();
  });
});

describe('Property Mogul', () => {
  const game = (config?: unknown) => {
    const g = newGame(['Asha', 'Bilal'], config);
    assign(g, { Asha: 'PROPERTY_MOGUL', Bilal: 'BUILDER' });
    return g;
  };

  it('completed: three properties whose original prices total ₹12,000 or more', () => {
    const g = game();
    for (const key of ['MUMBAI', 'INDORE', 'PATNA'] as const) g.give('Asha', key); // 8,500 + 1,500 + 2,000 = 12,000
    end(g);
    expect(resultOf(g, 'Asha')).toEqual({
      playerId: g.id('Asha'),
      objectiveId: 'PROPERTY_MOGUL',
      completed: true,
      reward: 5000,
      detail: 'Finished with 3 properties with original prices of ₹12,000 (needs 3 or more, ₹12,000).',
    });
  });

  it('failed: enough value in only two properties', () => {
    const g = game();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'AIR_INDIA'); // 19,000 in two
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0 });
  });

  it('failed: three properties worth ₹100 too little', () => {
    const g = game();
    for (const key of ['CALCUTTA', 'SHIMLA', 'WATER_WORKS'] as const) g.give('Asha', key); // 6,500 + 2,200 + 3,200 = 11,900
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0, detail: 'Finished with 3 properties with original prices of ₹11,900 (needs 3 or more, ₹12,000).' });
  });

  it('uses the price on the deed: the market cannot move the target', () => {
    const crashed = game();
    for (const key of ['MUMBAI', 'INDORE', 'PATNA'] as const) {
      crashed.give('Asha', key);
      eco(crashed).market[key].value = 100;
    }
    end(crashed);
    expect(resultOf(crashed, 'Asha').completed).toBe(true);

    const boomed = game();
    for (const key of ['INDORE', 'PATNA', 'SHIMLA'] as const) {
      boomed.give('Asha', key); // 5,700 on the deeds
      eco(boomed).market[key].value = 20000;
    }
    end(boomed);
    expect(resultOf(boomed, 'Asha').completed).toBe(false);
    for (const key of ['INDORE', 'PATNA', 'SHIMLA'] as const) expect(getDeed(key).price).toBeLessThan(2500);
  });

  it('mortgaged properties are still owned and still count', () => {
    const g = game();
    for (const key of ['MUMBAI', 'INDORE', 'PATNA'] as const) g.give('Asha', key, { mortgaged: true });
    end(g);
    expect(resultOf(g, 'Asha').completed).toBe(true);
  });

  it('the target scales with starting cash, the count of three does not', () => {
    const low = game({ startingCash: 10000 }); // ₹4,800
    for (const key of ['INDORE', 'PATNA', 'SHIMLA'] as const) low.give('Asha', key); // 5,700
    end(low);
    expect(resultOf(low, 'Asha')).toMatchObject({ completed: true, reward: 2000 });

    const lowTwo = game({ startingCash: 10000 });
    lowTwo.give('Asha', 'MUMBAI');
    lowTwo.give('Asha', 'AIR_INDIA');
    end(lowTwo);
    expect(resultOf(lowTwo, 'Asha').completed).toBe(false); // plenty of value, still only two

    const high = game({ startingCash: 50000 }); // ₹24,000
    for (const key of ['MUMBAI', 'CALCUTTA', 'INDORE'] as const) high.give('Asha', key); // 16,500
    end(high);
    expect(resultOf(high, 'Asha').completed).toBe(false);

    const highDone = game({ startingCash: 50000 });
    for (const key of ['MUMBAI', 'CALCUTTA', 'AIR_INDIA'] as const) highDone.give('Asha', key); // 25,500
    end(highDone);
    expect(resultOf(highDone, 'Asha')).toMatchObject({ completed: true, reward: 10000 });
  });
});

describe('The Builder', () => {
  const game = () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'BUILDER', Bilal: 'PROPERTY_MOGUL' });
    return g;
  };

  it('completed: three houses in total, on one property or spread over several', () => {
    const one = game();
    one.give('Asha', 'MUMBAI', { houses: 3 });
    end(one);
    expect(resultOf(one, 'Asha')).toEqual({ playerId: one.id('Asha'), objectiveId: 'BUILDER', completed: true, reward: 4000, detail: 'Finished with 3 houses (needs 3).' });

    const spread = game();
    spread.give('Asha', 'MUMBAI', { houses: 2 });
    spread.give('Asha', 'INDORE', { houses: 1 });
    end(spread);
    expect(resultOf(spread, 'Asha').completed).toBe(true);
  });

  it('failed: two houses', () => {
    const g = game();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0, detail: 'Finished with 2 houses (needs 3).' });
  });

  it('a hotel is not three houses: the game stores a hotel with none', () => {
    const g = game();
    g.give('Asha', 'MUMBAI', { houses: 0, hotel: true });
    g.give('Asha', 'INDORE', { houses: 2 });
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, detail: 'Finished with 2 houses (needs 3).' });
  });

  it('houses built with real actions count; houses on a property that has left the player do not', () => {
    const g = game();
    g.give('Asha', 'INDORE');
    for (let i = 0; i < 3; i += 1) g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' });
    expect(objectiveView(g.state, g.id('Asha'))!.check).toEqual({ completed: true, progress: '3 houses (needs 3)' });
    // The property goes to Bilal with its houses: they are his now.
    trade(g, 'Asha', 'Bilal', 'INDORE');
    expect(objectiveView(g.state, g.id('Asha'))!.check).toEqual({ completed: false, progress: '0 houses (needs 3)' });
    end(g);
    expect(resultOf(g, 'Asha').completed).toBe(false);
  });

  it('the goal is the same at any starting cash; only the bonus scales', () => {
    const g = newGame(['Asha', 'Bilal'], { startingCash: 10000 });
    assign(g, { Asha: 'BUILDER', Bilal: 'PROPERTY_MOGUL' });
    g.give('Asha', 'MUMBAI', { houses: 3 });
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: true, reward: 1600 });
  });
});

describe('Cash Guardian', () => {
  const game = (config?: unknown) => {
    const g = newGame(['Asha', 'Bilal'], config);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'BUILDER' });
    return g;
  };

  it('completed: at least ₹12,000 in cash and nothing overdue', () => {
    const g = game();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 13000 });
    end(g);
    expect(resultOf(g, 'Asha')).toEqual({ playerId: g.id('Asha'), objectiveId: 'CASH_GUARDIAN', completed: true, reward: 4000, detail: 'Finished with ₹12,000 cash (needs ₹12,000).' });
  });

  it('failed: ₹100 short', () => {
    const g = game();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 13100 });
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0, detail: 'Finished with ₹11,900 cash (needs ₹12,000).' });
  });

  it('only cash counts: property, however valuable, and borrowing room do not', () => {
    const g = game();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 20000 });
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'AIR_INDIA');
    expect(netWorth(g.state, g.id('Asha'))).toBeGreaterThan(20000);
    end(g);
    expect(resultOf(g, 'Asha').completed).toBe(false);
  });

  it('failed: enough cash, but an installment is overdue', () => {
    const g = game();
    borrow(g, 'Asha', 'PERSONAL', 9000);
    jumpTo(g, YEAR + WINDOW);
    expect(eco(g).loans[0]!.installments[0]!.status).toBe('OVERDUE');
    expect(g.balance('Asha')).toBeGreaterThan(30000);
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0 });
    expect(resultOf(g, 'Asha').detail).toMatch(/with a loan payment overdue or in default/);
  });

  it('a loan that is being repaid on time does not fail it', () => {
    const g = game();
    borrow(g, 'Asha', 'PERSONAL', 9000);
    jumpTo(g, YEAR);
    expect(eco(g).loans[0]!.installments[0]!.status).toBe('DUE');
    end(g);
    expect(resultOf(g, 'Asha').completed).toBe(true);
  });

  it.each([
    [10000, 4800, 1600],
    [50000, 24000, 8000],
  ])('starting cash %i: the threshold is %i and the bonus %i', (startingCash, threshold, reward) => {
    const pass = game({ startingCash });
    pass.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: pass.id('Bilal'), amount: startingCash - threshold });
    end(pass);
    expect(resultOf(pass, 'Asha')).toMatchObject({ completed: true, reward });
    const fail = game({ startingCash });
    fail.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: fail.id('Bilal'), amount: startingCash - threshold + 100 });
    end(fail);
    expect(resultOf(fail, 'Asha')).toMatchObject({ completed: false, reward: 0 });
  });
});

describe('Deal Maker', () => {
  const game = (names = ['Asha', 'Bilal', 'Chitra']) => {
    const g = newGame(names);
    assign(g, { Asha: 'DEAL_MAKER', Bilal: 'BUILDER', ...(names.includes('Chitra') ? { Chitra: 'PROPERTY_MOGUL' } : {}) });
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'INDORE');
    g.give('Bilal', 'DELHI');
    return g;
  };
  const count = (g: TestGame, name: string) => completedTradeCount(g.state.objectives, g.id(name));

  it('completed: two accepted property trades, as the offerer or the accepter', () => {
    const g = game();
    trade(g, 'Asha', 'Bilal', 'MUMBAI');
    trade(g, 'Bilal', 'Asha', 'DELHI');
    expect(count(g, 'Asha')).toBe(2);
    expect(count(g, 'Bilal')).toBe(2);
    expect(count(g, 'Chitra')).toBe(0);
    end(g);
    expect(resultOf(g, 'Asha')).toEqual({ playerId: g.id('Asha'), objectiveId: 'DEAL_MAKER', completed: true, reward: 4000, detail: 'Finished with 2 trades completed (needs 2).' });
  });

  it('failed: one trade', () => {
    const g = game();
    trade(g, 'Asha', 'Bilal', 'MUMBAI');
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0, detail: 'Finished with 1 trade completed (needs 2).' });
  });

  it('offers alone count for nothing: pending, rejected, cancelled and expired', () => {
    const g = game();
    const offer = (key: PropertyKey) => {
      g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: [key], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 });
      return g.state.trades.at(-1)!.id;
    };
    g.act('Bilal', { type: 'REJECT_TRADE', tradeId: offer('MUMBAI') });
    g.act('Asha', { type: 'CANCEL_TRADE', tradeId: offer('MUMBAI') });
    offer('MUMBAI'); // left pending
    offer('INDORE');
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'INDORE' }); // expires that offer
    for (let i = 0; i < 5; i += 1) offer('MUMBAI'); // repeated requests
    expect(g.state.objectives!.trades).toEqual([]);
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, detail: 'Finished with 0 trades completed (needs 2).' });
  });

  it('a trade must move a property: money alone is not a trade the game accepts', () => {
    const g = game();
    expect(refusal(() => g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: [], requestedPropertyKeys: [], offeredMoney: 500, requestedMoney: 0 })).code).toBe('TRADE_NOT_ALLOWED');
    // Paying a player is not a trade either.
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 500 });
    expect(count(g, 'Asha')).toBe(0);
  });

  it('an undone trade stops counting; undoing and repeating it counts once', () => {
    const g = game(['Asha', 'Bilal']);
    const accepted = trade(g, 'Asha', 'Bilal', 'MUMBAI');
    expect(count(g, 'Asha')).toBe(1);
    const undo = () => {
      g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: g.state.undoStack.at(-1)!.actionId });
      g.act('Bilal', { type: 'APPROVE_UNDO', requestId: g.state.undoRequest!.id });
    };
    undo();
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    expect(count(g, 'Asha')).toBe(0);
    expect(count(g, 'Bilal')).toBe(0);
    // Same deal again, and again: undo-and-repeat can never add up.
    for (let i = 0; i < 3; i += 1) {
      trade(g, 'Asha', 'Bilal', 'MUMBAI');
      expect(count(g, 'Asha')).toBe(1);
      undo();
      expect(count(g, 'Asha')).toBe(0);
    }
    trade(g, 'Asha', 'Bilal', 'MUMBAI');
    expect(count(g, 'Asha')).toBe(1);
    expect(accepted.events.some((e) => e.type === 'TRADE_ACCEPTED')).toBe(true);
    end(g);
    expect(resultOf(g, 'Asha').completed).toBe(false);
  });

  it('each completed trade is recorded once, under the action that executed it', () => {
    const g = game();
    const accepted = trade(g, 'Asha', 'Bilal', 'MUMBAI');
    const recorded = g.state.objectives!.trades;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ playerIds: [g.id('Asha'), g.id('Bilal')] });
    expect(recorded[0]!.actionId).toBe(g.state.undoStack.at(-1)!.actionId);
    expect(new Set(recorded.map((t) => t.tradeId)).size).toBe(recorded.length);
    // Accepting the same offer a second time is refused: it cannot be counted twice.
    expect(refusal(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: recorded[0]!.tradeId })).code).toBe('TRADE_NOT_ALLOWED');
    expect(g.state.objectives!.trades).toHaveLength(1);
    expect(accepted.transactions.every((t) => t.type === 'TRADE_PAYMENT')).toBe(true);
  });

  it('trades are tracked for everyone alike, so the count gives no objective away', () => {
    const g = game();
    assign(g, { Asha: 'BUILDER', Bilal: 'CASH_GUARDIAN', Chitra: 'PROPERTY_MOGUL' }); // nobody is Deal Maker
    trade(g, 'Asha', 'Bilal', 'MUMBAI');
    expect(count(g, 'Asha')).toBe(1);
    expect(count(g, 'Bilal')).toBe(1);
  });

  it('nothing is tracked when objectives are off, or in Classic', () => {
    const off = newGame(['Asha', 'Bilal'], { secretObjectives: false });
    off.give('Asha', 'MUMBAI');
    trade(off, 'Asha', 'Bilal', 'MUMBAI');
    expect(off.state.objectives).toBeNull();
    const classic = new TestGame(['Asha', 'Bilal']);
    classic.give('Asha', 'MUMBAI');
    trade(classic, 'Asha', 'Bilal', 'MUMBAI');
    expect(classic.state.objectives).toBeNull();
  });
});

describe('the end of the game', () => {
  it('pays each completed objective once, from the bank, as its own kind of transaction', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'BUILDER', Chitra: 'PROPERTY_MOGUL' });
    for (const key of ['MUMBAI', 'INDORE', 'PATNA'] as const) g.give('Chitra', key);
    const r = end(g);
    expect(rewards(g)).toMatchObject([
      { type: 'OBJECTIVE_REWARD', fromPlayerId: null, toPlayerId: g.id('Asha'), amount: 4000, memo: 'Secret objective bonus: Cash Guardian' },
      { type: 'OBJECTIVE_REWARD', fromPlayerId: null, toPlayerId: g.id('Chitra'), amount: 5000, memo: 'Secret objective bonus: Property Mogul' },
    ]);
    expect(g.balance('Asha')).toBe(29000);
    expect(g.balance('Bilal')).toBe(25000);
    expect(g.balance('Chitra')).toBe(30000);
    // The bonus is the only money the ending moved.
    expect(r.transactions.every((t) => t.type === 'OBJECTIVE_REWARD')).toBe(true);
    expect(r.events.filter((e) => e.type === 'OBJECTIVE_RESULT').map((e) => e.message)).toEqual([
      'Asha completed the secret objective “Cash Guardian” — ₹4,000 bonus',
      'Bilal did not complete the secret objective “The Builder”',
      'Chitra completed the secret objective “Property Mogul” — ₹5,000 bonus',
    ]);
    g.assertInvariants();
  });

  it('stores a result for every player: the objective, the outcome, the bonus paid and why', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'DEAL_MAKER' });
    end(g);
    expect(g.state.objectives!.results).toEqual([
      { playerId: g.id('Asha'), objectiveId: 'CASH_GUARDIAN', completed: true, reward: 4000, detail: 'Finished with ₹25,000 cash (needs ₹12,000).' },
      { playerId: g.id('Bilal'), objectiveId: 'DEAL_MAKER', completed: false, reward: 0, detail: 'Finished with 0 trades completed (needs 2).' },
    ]);
  });

  it('is evaluated only at the end: completing a goal mid-game pays nothing', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'BUILDER', Bilal: 'CASH_GUARDIAN' });
    g.give('Asha', 'INDORE');
    for (let i = 0; i < 3; i += 1) g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' });
    for (let i = 0; i < 4; i += 1) tick(g);
    expect(rewards(g)).toEqual([]);
    expect(g.state.objectives!.results).toBeNull();
    // …and selling a house before the end loses it.
    g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'INDORE' });
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: false, reward: 0 });
  });

  it('all objectives are judged on the same final state: one bonus cannot complete another', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'CASH_GUARDIAN' });
    // Bilal is ₹1,000 short of the threshold. No bonus paid at the end may lift him over it.
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 14000 });
    end(g);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: true, reward: 4000 });
    expect(resultOf(g, 'Bilal')).toMatchObject({ completed: false, reward: 0 });
    expect(g.balance('Bilal')).toBe(11000);
  });

  it('the winner is decided after the bonuses, on the final balances', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'BUILDER', Bilal: 'CASH_GUARDIAN' });
    g.give('Asha', 'INDORE'); // Asha is ahead by ₹1,500 before any bonus
    expect(netWorth(g.state, g.id('Asha'))).toBeGreaterThan(netWorth(g.state, g.id('Bilal')));
    const r = end(g);
    expect(g.state.winnerId).toBe(g.id('Bilal'));
    const finished = r.events.find((e) => e.type === 'GAME_FINISHED')!;
    expect(finished.message).toBe('Bilal wins! 🏆');
    expect(finished.payload.standings).toEqual([
      { playerId: g.id('Bilal'), netWorth: 29000 },
      { playerId: g.id('Asha'), netWorth: 26500 },
    ]);
    // The declared standings are the real final numbers.
    for (const s of finished.payload.standings as { playerId: string; netWorth: number }[]) expect(netWorth(g.state, s.playerId)).toBe(s.netWorth);
    // Results are announced before the winner.
    const types = r.events.map((e) => e.type);
    expect(types.lastIndexOf('OBJECTIVE_RESULT')).toBeLessThan(types.indexOf('GAME_FINISHED'));
  });

  it('a finished game cannot be finished again: no second evaluation, no second bonus', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'CASH_GUARDIAN' });
    end(g);
    const results = structuredClone(g.state.objectives!.results);
    expect(rewards(g)).toHaveLength(2);
    for (const name of ['Asha', 'Bilal']) {
      expect(refusal(() => g.act(name, { type: 'END_GAME' })).code).toBe('GAME_FINISHED');
      expect(refusal(() => g.act(name, { type: 'LEAVE_GAME' })).code).toBe('GAME_FINISHED');
    }
    expect(rewards(g)).toHaveLength(2);
    expect(g.state.objectives!.results).toEqual(results);
    expect(g.balance('Asha')).toBe(29000);
  });

  it('a bankrupt player earns no bonus, and bankruptcy and the winner work as they always did', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'BUILDER', Bilal: 'DEAL_MAKER' });
    // Bilal completes Deal Maker…
    g.give('Bilal', 'DELHI');
    g.give('Bilal', 'INDORE');
    trade(g, 'Bilal', 'Asha', 'DELHI');
    trade(g, 'Bilal', 'Asha', 'INDORE');
    expect(completedTradeCount(g.state.objectives, g.id('Bilal'))).toBe(2);
    // …then goes bankrupt on Asha's rent (one house: ₹4,000, more than he can have left even after passing Start).
    g.give('Asha', 'MUMBAI', { houses: 1 });
    tick(g);
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: g.balance('Bilal') - 100 });
    g.placeBefore('Bilal', 'MUMBAI', 4);
    g.roll('Bilal', 2, 2);
    const r = g.act('Bilal', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state.status).toBe('FINISHED');
    expect(g.state.winnerId).toBe(g.id('Asha'));
    expect(r.events.find((e) => e.type === 'GAME_FINISHED')!.payload.reason).toBe('LAST_PLAYER_STANDING');
    expect(resultOf(g, 'Bilal')).toEqual({ playerId: g.id('Bilal'), objectiveId: 'DEAL_MAKER', completed: false, reward: 0, detail: 'Went bankrupt before it ended — no bonus.' });
    expect(resultOf(g, 'Asha')).toMatchObject({ objectiveId: 'BUILDER', completed: false, reward: 0 });
    expect(rewards(g)).toEqual([]);
    expect(g.balance('Bilal')).toBe(0);
    g.assertInvariants();
  });

  it('the last player standing still collects a bonus they earned', () => {
    const g = newGame(['Asha', 'Bilal']);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'BUILDER' });
    g.give('Asha', 'MUMBAI', { houses: 1 });
    tick(g);
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: g.balance('Bilal') - 100 });
    g.placeBefore('Bilal', 'MUMBAI', 4);
    g.roll('Bilal', 2, 2);
    const before = g.balance('Asha');
    const settlement = g.balance('Bilal');
    g.act('Bilal', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state.winnerId).toBe(g.id('Asha'));
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: true, reward: 4000 });
    expect(g.balance('Asha')).toBe(before + settlement + 4000); // Bilal's last cash, then the bonus
    expect(rewards(g)).toHaveLength(1);
  });

  it('a player who left earns no bonus; the others are judged as usual', () => {
    const g = newGame(['Asha', 'Bilal', 'Chitra']);
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'CASH_GUARDIAN', Chitra: 'BUILDER' });
    g.act('Bilal', { type: 'LEAVE_GAME' });
    end(g);
    expect(resultOf(g, 'Bilal')).toEqual({ playerId: g.id('Bilal'), objectiveId: 'CASH_GUARDIAN', completed: false, reward: 0, detail: 'Left the game before it ended — no bonus.' });
    expect(g.balance('Bilal')).toBe(25000);
    expect(resultOf(g, 'Asha')).toMatchObject({ completed: true, reward: 4000 });
  });

  it('with objectives off the game ends exactly as before: no results, no bonus, plain net worth', () => {
    const g = newGame(['Asha', 'Bilal'], { secretObjectives: false });
    g.give('Asha', 'INDORE');
    const r = end(g);
    expect(g.state.objectives).toBeNull();
    expect(r.transactions).toEqual([]);
    expect(r.events.map((e) => e.type)).toEqual(['GAME_FINISHED']);
    expect(g.state.winnerId).toBe(g.id('Asha'));
    expect(r.events[0]!.payload.standings).toEqual([
      { playerId: g.id('Asha'), netWorth: 26500 },
      { playerId: g.id('Bilal'), netWorth: 25000 },
    ]);
  });

  it('bonuses use the game’s starting cash, read from its locked settings', () => {
    const g = newGame(['Asha', 'Bilal'], { startingCash: 40000 });
    assign(g, { Asha: 'CASH_GUARDIAN', Bilal: 'PROPERTY_MOGUL' });
    for (const key of ['MUMBAI', 'CALCUTTA', 'AIR_INDIA'] as const) g.give('Bilal', key); // 25,500 ≥ 19,200
    end(g);
    expect(rewards(g).map((t) => t.amount)).toEqual([6400, 8000]);
    expect(g.balance('Asha')).toBe(46400);
    expect(g.balance('Bilal')).toBe(48000);
  });
});
