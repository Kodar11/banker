import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE,
  BUSINESS_MVP_RULES,
  configOf,
  defaultGameConfig,
  GAME_CONFIG_LIMITS,
  gameConfigSummary,
  GameError,
  getDeed,
  INTERMEDIATE_RULES,
  intermediateRuleEntries,
  isDefaultGameConfig,
  legacyGameConfig,
  loanOffers,
  loanRequestBlocker,
  MARKET_VOLATILITIES,
  mortgagePayout,
  normalizeGameConfig,
  offeredRate,
  parseGameConfig,
  pickMarketChange,
  PROPERTY_KEYS,
  ruleSections,
  topRules,
  unmortgageCost,
  type GameConfig,
  type GameState,
  type IntermediateState,
  type LoanProductKey,
  type PropertyKey,
} from '@/engine/index.ts';
import { faceToRandom, TestGame } from './harness.ts';

const R = BUSINESS_MVP_RULES;
const IR = INTERMEDIATE_RULES;
const CASH = GAME_CONFIG_LIMITS.startingCash;
const LOAN = GAME_CONFIG_LIMITS.loanLimit;

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof GameError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the engine to refuse');
}

const eco = (g: TestGame): IntermediateState => g.state.intermediate!;

function borrow(g: TestGame, name: string, product: LoanProductKey, amount: number, collateralKey?: PropertyKey) {
  const expectedRatePercent = offeredRate(product, eco(g).credit[g.id(name)]!).ratePercent;
  return g.act(name, { type: 'TAKE_INTERMEDIATE_LOAN', product, amount, expectedRatePercent, ...(collateralKey ? { collateralKey } : {}) });
}

// ---------------------------------------------------------------------------

describe('defaults reproduce the game as it was', () => {
  it('Classic: ₹25,000 starting cash, ₹20,000 loan limit, nothing from Intermediate', () => {
    expect(defaultGameConfig('classic')).toEqual({ startingCash: 25000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: false });
    expect(defaultGameConfig('classic').startingCash).toBe(R.startingCash);
    expect(defaultGameConfig('classic').loanLimit).toBe(R.loans.maxOutstandingPrincipal);
  });

  it('Intermediate: the same money rules, the Balanced market, objectives on', () => {
    expect(defaultGameConfig('intermediate')).toEqual({ startingCash: 25000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: true });
    expect(defaultGameConfig('intermediate').loanLimit).toBe(IR.loans.maxOutstandingPrincipal);
    expect(IR.market.defaultProfile).toBe('balanced');
  });

  it('the defaults sit inside the limits a host can pick from', () => {
    for (const mode of ['classic', 'intermediate'] as const) {
      const d = defaultGameConfig(mode);
      expect(parseGameConfig(mode, d)).toEqual(d);
      expect(isDefaultGameConfig(mode, d)).toBe(true);
    }
    expect(CASH).toEqual({ min: 10000, max: 50000, step: 5000 });
    expect(LOAN).toEqual({ min: 5000, max: 50000, step: 5000 });
  });

  it('a game created with no settings gets the defaults, and plays with them', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    expect(g.state.config).toEqual(defaultGameConfig('classic'));
    expect(g.balance('Asha')).toBe(25000);
    expect(g.balance('Bilal')).toBe(25000);
    expect(g.state.objectives).toBeNull();
    expect(g.state.intermediate).toBeNull();
  });

  it('a state stored before settings existed (no config at all) still loads and plays by the old rules', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    delete (g.state as Partial<GameState>).config;
    expect(configOf(g.state)).toEqual(legacyGameConfig('classic'));
    g.queueRandom(0.999);
    g.act('Asha', { type: 'START_GAME' });
    expect(g.balance('Asha')).toBe(25000);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 });
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 })).message).toMatch(/Loan limit is ₹20,000/);
  });

  it('a stored config that is missing or unreadable falls back to the old rules — and an old Intermediate game has no objectives', () => {
    expect(normalizeGameConfig('classic', null)).toEqual(legacyGameConfig('classic'));
    expect(normalizeGameConfig('intermediate', undefined)).toEqual({ startingCash: 25000, loanLimit: 20000, marketVolatility: 'balanced', secretObjectives: false });
    expect(normalizeGameConfig('intermediate', { startingCash: 'lots' })).toEqual(legacyGameConfig('intermediate'));
    expect(normalizeGameConfig('intermediate', { startingCash: 40000, loanLimit: 5000, marketVolatility: 'volatile', secretObjectives: true })).toEqual({
      startingCash: 40000,
      loanLimit: 5000,
      marketVolatility: 'volatile',
      secretObjectives: true,
    });
  });
});

describe('starting cash', () => {
  it.each([
    ['classic', CASH.min],
    ['classic', 25000],
    ['classic', CASH.max],
    ['intermediate', CASH.min],
    ['intermediate', 25000],
    ['intermediate', CASH.max],
  ] as const)('%s game with %i: every player starts with exactly that, from the bank', (mode, startingCash) => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra'], { mode, config: { startingCash } });
    expect(g.state.config.startingCash).toBe(startingCash);
    for (const name of ['Asha', 'Bilal', 'Chitra']) expect(g.balance(name)).toBe(startingCash);
    const funds = g.ledger.filter((t) => t.type === 'STARTING_FUNDS');
    expect(funds).toHaveLength(3);
    expect(funds.every((t) => t.amount === startingCash && t.fromPlayerId === null)).toBe(true);
  });

  it.each([
    [9999, /at least ₹10,000/],
    [5000, /at least ₹10,000/],
    [0, /at least ₹10,000/],
    [-25000, /at least ₹10,000/],
    [55000, /at most ₹50,000/],
    [1_000_000, /at most ₹50,000/],
    [12500, /multiple of ₹5,000/],
    [25000.5, /whole number/],
    ['25000', /must be a number/],
    [null, /must be a number/],
    [Number.NaN, /must be a number/],
  ])('refuses %s', (startingCash, message) => {
    const r = refusal(() => parseGameConfig('classic', { startingCash }));
    expect(r.code).toBe('VALIDATION');
    expect(r.message).toMatch(message);
  });

  it('an invalid value never creates a game', () => {
    expect(refusal(() => new TestGame(['Asha', 'Bilal'], { config: { startingCash: 60000 } })).code).toBe('VALIDATION');
  });

  it('the Start reward, taxes and prices do not move with it', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { startingCash: 50000 } });
    g.placeAt('Asha', BOARD_SIZE - 2);
    g.roll('Asha', 1, 1);
    expect(g.balance('Asha')).toBe(50000 + R.start.passReward);
    expect(getDeed('MUMBAI').price).toBe(8500);
  });
});

describe('loan limit — Classic', () => {
  it('default: ₹20,000 exactly as before', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 20000 });
    expect(g.balance('Asha')).toBe(45000);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 }))).toEqual({ code: 'LOAN_NOT_ALLOWED', message: 'Loan limit is ₹20,000. You can borrow ₹0 more.' });
  });

  it.each([LOAN.min, LOAN.max])('a custom limit of %i caps the principal owed, and nothing else about the loan changes', (loanLimit) => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { loanLimit } });
    const r = g.act('Asha', { type: 'REQUEST_LOAN', amount: loanLimit });
    expect(g.balance('Asha')).toBe(25000 + loanLimit);
    // Same loan terms as ever: 10% interest, due at the next Start.
    expect(g.state.loans[0]).toMatchObject({ principal: loanLimit, interestRatePercent: 10, interestAmount: loanLimit / 10, outstanding: loanLimit });
    expect(r.transactions).toMatchObject([{ type: 'LOAN_DISBURSEMENT', amount: loanLimit }]);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 })).code).toBe('LOAN_NOT_ALLOWED');
    // Repaying frees the room again.
    g.act('Asha', { type: 'REPAY_LOAN', loanId: g.state.loans[0]!.id, amount: 1000 });
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 });
  });

  it('the minimum loan and the step are untouched', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { loanLimit: 50000 } });
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 500 })).message).toMatch(/Minimum loan is ₹1,000/);
    expect(refusal(() => g.act('Asha', { type: 'REQUEST_LOAN', amount: 1250 })).message).toMatch(/steps of ₹500/);
  });

  it.each([
    [4999, /at least ₹5,000/],
    [0, /at least ₹5,000/],
    [55000, /at most ₹50,000/],
    [7500, /multiple of ₹5,000/],
    ['20000', /must be a number/],
  ])('refuses a limit of %s', (loanLimit, message) => {
    expect(refusal(() => parseGameConfig('classic', { loanLimit })).message).toMatch(message);
  });

  it('mortgages are a separate rule and do not change with it', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { loanLimit: 5000, startingCash: 10000 } });
    g.give('Asha', 'MUMBAI');
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(g.balance('Asha')).toBe(10000 + mortgagePayout('MUMBAI'));
    expect(mortgagePayout('MUMBAI')).toBe(4250);
    expect(unmortgageCost('MUMBAI')).toBe(4675);
    // A mortgage is not a loan: the full loan limit is still there.
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 5000 });
  });
});

describe('loan limit — Intermediate', () => {
  const game = (loanLimit?: number) => new TestGame(['Asha', 'Bilal'], { mode: 'intermediate', config: loanLimit ? { loanLimit } : undefined });
  const max = (g: TestGame, product: LoanProductKey) => loanOffers(g.state, g.id('Asha')).find((o) => o.product === product)!.maxAmount;

  it('default ₹20,000: the offers are what they were', () => {
    const g = game();
    expect([max(g, 'EMERGENCY'), max(g, 'PERSONAL'), max(g, 'LONG_TERM'), max(g, 'FLEXIBLE')]).toEqual([5000, 10000, 15000, 10000]);
    borrow(g, 'Asha', 'LONG_TERM', 15000);
    borrow(g, 'Asha', 'EMERGENCY', 5000);
    expect(refusal(() => borrow(g, 'Asha', 'PERSONAL', 1000)).message).toMatch(/₹20,000 borrowing limit/);
  });

  it('a lower limit caps every offer', () => {
    const g = game(5000);
    expect([max(g, 'EMERGENCY'), max(g, 'PERSONAL'), max(g, 'LONG_TERM'), max(g, 'FLEXIBLE')]).toEqual([5000, 5000, 5000, 5000]);
    expect(loanRequestBlocker(g.state, g.id('Asha'), 'PERSONAL', 6000, null)).toBe('Your total borrowing limit is ₹5,000. You can borrow ₹5,000 more.');
    borrow(g, 'Asha', 'PERSONAL', 5000);
    expect(refusal(() => borrow(g, 'Asha', 'EMERGENCY', 1000)).message).toBe('You have reached the ₹5,000 borrowing limit.');
  });

  it('a higher limit never lifts a product’s own maximum', () => {
    const g = game(50000);
    expect([max(g, 'EMERGENCY'), max(g, 'PERSONAL'), max(g, 'LONG_TERM'), max(g, 'FLEXIBLE')]).toEqual([5000, 10000, 15000, 10000]);
    expect(refusal(() => borrow(g, 'Asha', 'PERSONAL', 15000)).message).toBe('Personal Loans go up to ₹10,000.');
    expect(refusal(() => borrow(g, 'Asha', 'EMERGENCY', 5500)).message).toBe('Emergency Loans go up to ₹5,000.');
    // …but several products together may now pass ₹20,000, up to the chosen limit.
    borrow(g, 'Asha', 'LONG_TERM', 15000);
    borrow(g, 'Asha', 'PERSONAL', 10000);
    borrow(g, 'Asha', 'FLEXIBLE', 10000);
    borrow(g, 'Asha', 'EMERGENCY', 5000);
    expect(g.balance('Asha')).toBe(25000 + 40000);
    expect(max(g, 'PERSONAL')).toBe(10000);
  });

  it('a higher limit never lifts the collateral requirement of a secured loan', () => {
    const g = game(50000);
    expect(max(g, 'SECURED')).toBe(0);
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 5000)).message).toMatch(/Needs a property you own outright/);
    g.give('Asha', 'DARJEELING'); // ₹2,500 → secures at most ₹1,000 (50%, rounded down to ₹500)
    expect(max(g, 'SECURED')).toBe(1000);
    expect(refusal(() => borrow(g, 'Asha', 'SECURED', 5000, 'DARJEELING')).message).toMatch(/can secure up to ₹1,000/);
  });

  it('overdue and default blocks still apply under any limit', () => {
    const g = game(50000);
    borrow(g, 'Asha', 'PERSONAL', 5000);
    const loan = eco(g).loans[0]!;
    loan.installments[0]!.status = 'OVERDUE';
    expect(loanOffers(g.state, g.id('Asha')).every((o) => o.maxAmount === 0 && /overdue payment/.test(o.blocked ?? ''))).toBe(true);
  });
});

describe('Classic takes nothing from Intermediate', () => {
  it('Intermediate-only settings sent for a Classic game are forced off', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { marketVolatility: 'volatile', secretObjectives: true } });
    expect(g.state.config).toEqual(defaultGameConfig('classic'));
    expect(g.state.objectives).toBeNull();
    expect(g.state.intermediate).toBeNull();
  });

  it('no market, no objectives and no bonus through a whole Classic game', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { startingCash: 30000, loanLimit: 10000 } });
    for (let i = 0; i < 12; i += 1) {
      const name = g.current;
      g.placeAt(name, BOARD_SIZE - 2);
      g.roll(name, 1, 1);
      g.act(name, { type: 'END_TURN' });
    }
    expect(g.state.intermediate).toBeNull();
    expect(g.state.objectives).toBeNull();
    const end = g.act('Asha', { type: 'END_GAME' });
    expect(g.state.objectives).toBeNull();
    expect(g.ledger.some((t) => t.type === 'OBJECTIVE_REWARD')).toBe(false);
    expect(g.results.flatMap((r) => r.events).some((e) => e.type === 'OBJECTIVE_RESULT' || e.type === 'FINANCIAL_YEAR_STARTED')).toBe(false);
    // Six passes of Start each, nothing else: the result is plain Classic net worth.
    expect(end.events.find((e) => e.type === 'GAME_FINISHED')!.payload.standings).toEqual([
      { playerId: g.id('Asha'), netWorth: 30000 + 6 * R.start.passReward },
      { playerId: g.id('Bilal'), netWorth: 30000 + 6 * R.start.passReward },
    ]);
  });

  it('the Classic summary lists only what applies to it', () => {
    expect(gameConfigSummary('classic', defaultGameConfig('classic'))).toEqual([
      { key: 'mode', label: 'Mode', value: 'Classic' },
      { key: 'startingCash', label: 'Starting cash', value: '₹25,000' },
      { key: 'loanLimit', label: 'Maximum outstanding loans', value: '₹20,000' },
    ]);
    expect(gameConfigSummary('intermediate', { startingCash: 30000, loanLimit: 25000, marketVolatility: 'balanced', secretObjectives: true }).map((r) => `${r.label}: ${r.value}`)).toEqual([
      'Mode: Intermediate',
      'Starting cash: ₹30,000',
      'Maximum outstanding loans: ₹25,000',
      'Market volatility: Balanced',
      'Secret objectives: Enabled',
    ]);
  });
});

describe('the settings belong to the host until the game starts, then to nobody', () => {
  const custom: GameConfig = { startingCash: 40000, loanLimit: 10000, marketVolatility: 'volatile', secretObjectives: false };

  it('the host can change them in the lobby; everyone gets the new values', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false, mode: 'intermediate' });
    const r = g.act('Asha', { type: 'UPDATE_CONFIG', config: custom });
    expect(g.state.config).toEqual(custom);
    expect(r.events).toMatchObject([{ type: 'GAME_CONFIG_UPDATED', message: 'Asha changed the game settings', payload: { config: custom } }]);
    g.queueRandom(0.999);
    g.act('Asha', { type: 'START_GAME' });
    expect(g.balance('Asha')).toBe(40000);
    expect(g.balance('Bilal')).toBe(40000);
    expect(g.state.objectives).toBeNull();
  });

  it('a partial update keeps nothing from before: missing settings return to their defaults', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false, config: { startingCash: 40000, loanLimit: 10000 } });
    g.act('Asha', { type: 'UPDATE_CONFIG', config: { loanLimit: 15000 } });
    expect(g.state.config).toEqual({ ...defaultGameConfig('classic'), loanLimit: 15000 });
  });

  it('nobody but the host can change them', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    expect(refusal(() => g.act('Bilal', { type: 'UPDATE_CONFIG', config: custom }))).toEqual({ code: 'FORBIDDEN', message: 'Only the host can change the game settings.' });
    expect(g.state.config).toEqual(defaultGameConfig('classic'));
  });

  it('an invalid change is refused whole and nothing is stored', () => {
    const g = new TestGame(['Asha', 'Bilal'], { start: false });
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { startingCash: 30000, loanLimit: 999 } })).code).toBe('VALIDATION');
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { startingCash: 30000, bonusCash: 1 } })).message).toBe('Those game settings are not valid.');
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { marketVolatility: 'wild' } })).message).toMatch(/Stable, Balanced or Volatile/);
    expect(g.state.config).toEqual(defaultGameConfig('classic'));
    // The mode is not a setting: it cannot be smuggled in.
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: { mode: 'intermediate' } })).code).toBe('VALIDATION');
    expect(g.state.mode).toBe('classic');
  });

  it('once the game starts they are locked — for the host too, running, paused or finished', () => {
    const g = new TestGame(['Asha', 'Bilal'], { config: { startingCash: 30000 } });
    const before = structuredClone(g.state.config);
    const locked = { code: 'INVALID_PHASE', message: 'The game has started — its settings are locked.' };
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: custom }))).toEqual(locked);
    expect(refusal(() => g.act('Bilal', { type: 'UPDATE_CONFIG', config: custom }))).toEqual(locked);
    g.act('Asha', { type: 'PAUSE_GAME' });
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: custom }))).toEqual(locked);
    g.act('Asha', { type: 'RESUME_GAME' });
    g.act('Asha', { type: 'END_GAME' });
    expect(refusal(() => g.act('Asha', { type: 'UPDATE_CONFIG', config: custom })).code).toBe('GAME_FINISHED');
    expect(g.state.config).toEqual(before);
  });

  it('no gameplay action ever changes them', () => {
    const g = new TestGame(['Asha', 'Bilal'], { mode: 'intermediate', config: custom });
    for (let i = 0; i < 6; i += 1) {
      const name = g.current;
      g.placeAt(name, BOARD_SIZE - 2);
      g.roll(name, 1, 1);
      g.act(name, { type: 'END_TURN' });
      expect(g.state.config).toEqual(custom);
    }
  });

  it('they survive the host leaving: the next host inherits the same settings', () => {
    const lobby = new TestGame(['Asha', 'Bilal', 'Chitra'], { start: false, config: { startingCash: 35000 } });
    lobby.act('Asha', { type: 'LEAVE_GAME' });
    expect(lobby.state.config.startingCash).toBe(35000);
    expect(lobby.player('Bilal').isHost).toBe(true);
    lobby.act('Bilal', { type: 'UPDATE_CONFIG', config: { startingCash: 45000 } });
    expect(lobby.state.config.startingCash).toBe(45000);

    const running = new TestGame(['Asha', 'Bilal', 'Chitra'], { config: { startingCash: 35000, loanLimit: 5000 } });
    running.act('Asha', { type: 'LEAVE_GAME' });
    expect(running.state.config).toEqual({ ...defaultGameConfig('classic'), startingCash: 35000, loanLimit: 5000 });
    expect(refusal(() => running.act('Bilal', { type: 'UPDATE_CONFIG', config: { startingCash: 45000 } })).code).toBe('INVALID_PHASE');
  });
});

describe('property-market volatility', () => {
  const table = (v: (typeof MARKET_VOLATILITIES)[number]) => Object.fromEntries(IR.market.profiles[v].map((c) => [c.percent, c.weight]));

  it('holds the agreed distributions', () => {
    expect(MARKET_VOLATILITIES).toEqual(['stable', 'balanced', 'volatile']);
    expect(table('stable')).toEqual({ '-10': 20, '0': 40, '10': 30, '20': 10 });
    expect(table('balanced')).toEqual({ '-20': 10, '-10': 20, '0': 20, '10': 30, '20': 20 });
    expect(table('volatile')).toEqual({ '-20': 20, '-10': 20, '0': 10, '10': 25, '20': 25 });
  });

  it.each(MARKET_VOLATILITIES)('%s sums to 100%%', (v) => {
    expect(IR.market.profiles[v].reduce((sum, c) => sum + c.weight, 0)).toBe(100);
  });

  it.each(MARKET_VOLATILITIES)('%s: the draw follows the weights exactly', (v) => {
    const counts: Record<string, number> = {};
    // One draw from the middle of each 1% slice: each change must come up exactly `weight` times.
    for (let i = 0; i < 100; i += 1) {
      const percent = pickMarketChange(() => (i + 0.5) / 100, v);
      counts[percent] = (counts[percent] ?? 0) + 1;
    }
    expect(counts).toEqual(table(v));
  });

  it('Stable never produces a 20% fall', () => {
    for (let i = 0; i < 1000; i += 1) expect(pickMarketChange(() => i / 1000, 'stable')).toBeGreaterThanOrEqual(-10);
  });

  it('no profile given means Balanced, as it always was', () => {
    for (const r of [0, 0.05, 0.15, 0.4, 0.6, 0.85, 0.999]) expect(pickMarketChange(() => r)).toBe(pickMarketChange(() => r, 'balanced'));
  });

  /** Runs a 2-player game to the first year boundary with every market draw fixed at `r`. */
  function firstYear(config: unknown, r: number) {
    const g = new TestGame(['Asha', 'Bilal'], { mode: 'intermediate', config });
    const movement = eco(g).movement;
    movement[g.id('Asha')] = 70;
    g.placeAt('Asha', BOARD_SIZE - 2);
    g.queueRandom(faceToRandom(1), faceToRandom(1), ...PROPERTY_KEYS.map(() => r));
    const result = g.act('Asha', { type: 'ROLL_DICE' });
    return { g, result };
  }

  it.each([
    ['stable', 0.15, -10],
    ['balanced', 0.15, -10],
    ['volatile', 0.15, -20],
    ['stable', 0.85, 10],
    ['balanced', 0.85, 20],
    ['volatile', 0.85, 20],
    [undefined, 0.05, -20],
    ['stable', 0.05, -10],
  ] as const)('a %s game draws its yearly change from its own profile (roll %f → %i%%)', (marketVolatility, r, percent) => {
    const { g, result } = firstYear(marketVolatility ? { marketVolatility } : undefined, r);
    expect(eco(g).year).toBe(2);
    for (const key of PROPERTY_KEYS) expect(eco(g).market[key].lastChangePercent).toBe(percent);
    // Every applied change and the value it produced are stored and announced with the action.
    const report = result.events.find((e) => e.type === 'FINANCIAL_YEAR_STARTED')!.payload.changes as Record<string, { percent: number; from: number; to: number }>;
    expect(report.MUMBAI).toEqual({ percent, from: 8500, to: eco(g).market.MUMBAI.value });
    expect(eco(g).lastReport!.changes.MUMBAI).toEqual(report.MUMBAI);
  });

  it('the profile changes values only: deed prices, rents, building costs and inflation stay put', () => {
    const { g } = firstYear({ marketVolatility: 'volatile' }, 0.05);
    expect(eco(g).market.MUMBAI.value).toBe(6800);
    const deed = getDeed('MUMBAI');
    expect(deed.kind === 'CITY' && [deed.price, deed.rent, deed.houseCost, deed.hotelCost, deed.mortgageValue]).toEqual([8500, [1200, 4000, 5500, 7500], 7500, 7500, 4250]);
    expect(IR.inflation.ratePercent).toBe(5);
  });

  it('a year’s change is applied once: more play in the same year re-rolls nothing', () => {
    const { g } = firstYear({ marketVolatility: 'volatile' }, 0.05);
    const after = structuredClone(eco(g).market);
    g.act('Asha', { type: 'END_TURN' });
    g.placeAt('Bilal', BOARD_SIZE - 2);
    g.roll('Bilal', 1, 1);
    expect(eco(g).market).toEqual(after);
  });
});

describe('the rulebook quotes the game being played', () => {
  const text = (rules: readonly { lines: readonly string[] }[]) => rules.flatMap((r) => r.lines).join('\n');

  it('standard settings read exactly as before', () => {
    expect(text(topRules())).toContain('Everyone starts with ₹25,000.');
    expect(text(ruleSections().flatMap((s) => s.rules))).toContain('with no more than ₹20,000 owed at once.');
  });

  it('custom settings replace those two figures and nothing else', () => {
    const config = { startingCash: 40000, loanLimit: 5000 };
    expect(text(topRules(config))).toContain('Everyone starts with ₹40,000.');
    expect(text(ruleSections(config).flatMap((s) => s.rules))).toContain('with no more than ₹5,000 owed at once.');
    const strip = (s: string) => s.replace('₹40,000', '₹25,000').replace('no more than ₹5,000', 'no more than ₹20,000');
    expect(strip(text(topRules(config)))).toBe(text(topRules()));
    expect(strip(text(ruleSections(config).flatMap((s) => s.rules)))).toBe(text(ruleSections().flatMap((s) => s.rules)));
  });

  it('Intermediate rules name the game’s market, its loan limit, and objectives only when they are on', () => {
    const on = intermediateRuleEntries({ startingCash: 50000, loanLimit: 30000, marketVolatility: 'stable', secretObjectives: true });
    expect(text(on)).toContain('changes on its own: -10%, 0%, +10%, +20%');
    expect(text(on)).toContain('This game’s market is Stable.'.replace('’', "'"));
    expect(text(on)).toContain('at most ₹30,000 owed in total');
    expect(on.map((r) => r.title)).toContain('Secret objectives');
    expect(text(on)).toContain('Property Mogul (₹10,000 bonus), The Builder (₹8,000 bonus), Cash Guardian (₹8,000 bonus), Deal Maker (₹8,000 bonus)');
    const off = intermediateRuleEntries({ ...defaultGameConfig('intermediate'), secretObjectives: false });
    expect(off.map((r) => r.title)).not.toContain('Secret objectives');
  });
});
