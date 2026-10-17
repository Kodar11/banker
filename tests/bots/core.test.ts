import { describe, expect, it } from 'vitest';
import {
  auctionOpensAt,
  computeRent,
  positionOfProperty,
  positionOfSpecial,
  PROPERTY_KEYS,
  topUndoable,
  tradeSignature,
  type GameAction,
} from '@/engine/index.ts';
import {
  actionKey,
  assess,
  buildValuationContext,
  clearLandingCache,
  DICE_DISTRIBUTION,
  DIMENSIONS,
  EXPECTED_ROLL,
  expectedRentFor,
  gameHorizon,
  DIFFICULTY_TUNING,
  knownOutflows,
  landingModel,
  maximumBid,
  nextBotMove,
  nextBotWakeAt,
  observe,
  PERSONALITY_WEIGHTS,
  personalityMultipliers,
  rollOutcome,
  seatSeed,
  type BotProfile,
} from '@/bots/index.ts';
import { botTable, decideAs, setCash } from './helpers';

const NORMAL: BotProfile = { difficulty: 'normal', personality: 'investor' };

function context(g: ReturnType<typeof botTable>, name: string, profile: BotProfile = NORMAL) {
  const id = g.id(name);
  const obs = observe(g.state, id, g.nowMs);
  return buildValuationContext(obs, { profile, seed: seatSeed(g.state.id, id) });
}

describe('dice', () => {
  it('two six-sided dice: 1/36 … 6/36 … 1/36, summing to 1, expected 7', () => {
    expect(DICE_DISTRIBUTION.map((d) => d.ways)).toEqual([1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
    expect(DICE_DISTRIBUTION.map((d) => d.total)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(DICE_DISTRIBUTION.reduce((s, d) => s + d.probability, 0)).toBeCloseTo(1, 12);
    expect(EXPECTED_ROLL).toBeCloseTo(7, 12);
  });
});

describe('board model (read from the engine’s board and card data)', () => {
  it('resolves cards by the dice total: Chance odd 9 sends the roller to Mumbai, passing Start', () => {
    const chance = positionOfSpecial('CHANCE');
    const out = rollOutcome(chance - 9 + 36, 9);
    expect(out.landed).toEqual(['MUMBAI']);
    expect(out.to).toBe(positionOfProperty('MUMBAI'));
    expect(out.passedStart).toBe(true);
    expect(out.cardReceive).toBe(3000);
  });

  it('landing on Jail jails; Chance odd 7 pays the jackpot; a tax square is a tax', () => {
    const jail = positionOfSpecial('JAIL');
    expect(rollOutcome(jail - 7, 7).jailed).toBe(true);
    expect(rollOutcome(positionOfSpecial('CHANCE') - 7, 7).cardReceive).toBe(2000);
    expect(rollOutcome(positionOfSpecial('INCOME_TAX') - 5, 5).tax).toBe('INCOME');
  });

  it('Easy’s next-roll model is the exact dice distribution', () => {
    clearLandingCache();
    const model = landingModel([{ id: 'p', position: 0, inJail: false, jailTurnsLeft: 0, skipTurns: 0 }], { weights: [1], model: 'one-roll', simulations: 0, seed: 1 });
    expect(model.landings.p!.AHMEDABAD).toBeCloseTo(3 / 36, 12); // 4 squares on
    expect(model.landings.p!.MUMBAI ?? 0).toBe(0); // 1 square on: no roll is that small
  });

  it('Normal/Hard’s Monte Carlo converges to the exact next-roll probabilities', () => {
    clearLandingCache();
    const mover = [{ id: 'p', position: 0, inJail: false, jailTurnsLeft: 0, skipTurns: 0 }];
    const exact = landingModel(mover, { weights: [1], model: 'one-roll', simulations: 0, seed: 1 });
    const mc = landingModel(mover, { weights: [1], model: 'monte-carlo', simulations: 20000, seed: 7 });
    for (const key of PROPERTY_KEYS) expect(Math.abs((mc.landings.p![key] ?? 0) - (exact.landings.p![key] ?? 0))).toBeLessThan(0.01);
  });

  it('is deterministic for the same seed', () => {
    clearLandingCache();
    const mover = [{ id: 'p', position: 3, inJail: false, jailTurnsLeft: 0, skipTurns: 0 }];
    const a = landingModel(mover, { weights: [1, 0.9, 0.8], model: 'monte-carlo', simulations: 256, seed: 5 });
    clearLandingCache();
    const b = landingModel(mover, { weights: [1, 0.9, 0.8], model: 'monte-carlo', simulations: 256, seed: 5 });
    expect(b).toEqual(a);
  });

  it('expected rent is the engine’s computeRent times the expected landings', () => {
    const g = botTable();
    g.give('Asha', 'MUMBAI');
    const model = landingModel(g.state.players, { weights: [1], model: 'one-roll', simulations: 0, seed: 1 });
    const payers = [g.id('Bilal'), g.id('Chitra'), g.id('Dev')];
    const landings = payers.reduce((s, id) => s + (model.landings[id]!.MUMBAI ?? 0), 0);
    expect(expectedRentFor(g.state, 'MUMBAI', payers, model)).toBeCloseTo(landings * computeRent(g.state, 'MUMBAI', 7), 9);
  });
});

describe('horizon', () => {
  it('hosted Classic: S_remaining = Y_limit × N × 36 − S_used, turns ≈ S / (active × 7)', () => {
    const g = botTable();
    const h = gameHorizon(g.state, DIFFICULTY_TUNING.normal);
    expect(h.hosted).toBe(true);
    expect(h.remainingTurns).toBeCloseTo((5 * 4 * 36) / (4 * 7), 9);
    expect(h.yearsLeft).toBeCloseTo(5, 9);
    expect(h.planningTurns).toBe(DIFFICULTY_TUNING.normal.maxPlanningTurns);
    // Movement recorded on the clock shortens it.
    g.state.endGame!.calendar!.movement[g.id('Asha')] = 600;
    expect(gameHorizon(g.state, DIFFICULTY_TUNING.normal).remainingTurns).toBeCloseTo(120 / 28, 9);
  });

  it('the clock counts the starting players, not the shrinking active ones', () => {
    const g = botTable();
    g.state.players = g.state.players.map((p) => (p.name === 'Dev' ? { ...p, status: 'BANKRUPT' } : p));
    const h = gameHorizon(g.state, DIFFICULTY_TUNING.normal);
    expect(h.remainingTurns).toBeCloseTo((5 * 4 * 36) / (3 * 7), 9);
  });

  it('a matchmade game plans over two financial years and is never treated as ending then', () => {
    const g = botTable();
    g.state = { ...g.state, hostPlayerId: null, endGame: null, players: g.state.players.map((p) => ({ ...p, isHost: false })) };
    const h = gameHorizon(g.state, DIFFICULTY_TUNING.hard);
    expect(h.hosted).toBe(false);
    expect(h.remainingTurns).toBe(Infinity);
    expect(h.planningTurns).toBeCloseTo(Math.min(DIFFICULTY_TUNING.hard.maxPlanningTurns, (2 * 36) / 7), 9);
  });

  it('Normal/Hard discount possible early endings; Easy does not', () => {
    const g = botTable();
    const easy = gameHorizon(g.state, DIFFICULTY_TUNING.easy);
    const normal = gameHorizon(g.state, DIFFICULTY_TUNING.normal);
    expect(easy.turnWeights[3]).toBeCloseTo(DIFFICULTY_TUNING.easy.turnDiscount ** 3, 12);
    expect(normal.turnWeights[3]!).toBeLessThan(DIFFICULTY_TUNING.normal.turnDiscount ** 3);
  });

  it('Capital Mode reads its own economy clock', () => {
    const g = botTable(undefined, NORMAL, { mode: 'intermediate' });
    expect(gameHorizon(g.state, DIFFICULTY_TUNING.normal).remainingTurns).toBeCloseTo((5 * 4 * 36) / (4 * 7), 9);
  });
});

describe('reserve and valuation', () => {
  it('R_base = max(₹2,000, 20% of the configured starting cash)', () => {
    expect(context(botTable(), 'Asha').reserveBase).toBe(5000);
    expect(context(botTable(undefined, NORMAL, { config: { startingCash: 10000 } }), 'Asha').reserveBase).toBe(2000);
  });

  it('O_known counts the payment the turn waits on, once', () => {
    const g = botTable();
    g.give('Bilal', 'MUMBAI');
    g.landOn('Asha', positionOfProperty('MUMBAI'), 3);
    expect(g.state.turn.phase).toBe('AWAITING_PAYMENT');
    expect(knownOutflows(g.state, g.id('Asha'))).toBe(computeRent(g.state, 'MUMBAI', 3));
  });

  it('group value is only the extra rent of a set — never counted twice', () => {
    const g = botTable();
    g.give('Asha', 'MUMBAI');
    const one = assess(context(g, 'Asha'), g.state);
    expect(one.components.group).toBeCloseTo(0, 9);
    g.give('Asha', 'CALCUTTA');
    g.give('Asha', 'HYDERABAD');
    const three = assess(context(g, 'Asha'), g.state);
    // Three of a colour double the rent: exactly half of the income is the set's.
    expect(three.components.group).toBeCloseTo(three.income / 2, 6);
  });

  it('completing a set makes a purchase worth more than the same purchase alone', () => {
    const alone = botTable();
    alone.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    const set = botTable();
    set.give('Asha', 'MUMBAI');
    set.give('Asha', 'CALCUTTA');
    set.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    const a = decideAs(alone, 'Asha');
    const b = decideAs(set, 'Asha');
    expect(b.action?.type).toBe('BUY_PROPERTY');
    expect(b.considered![0]!.score).toBeGreaterThan(a.considered![0]!.score * 2);
  });

  it('personality multipliers come from the agreed table: each column sums to 100, the average personality is neutral', () => {
    for (const w of Object.values(PERSONALITY_WEIGHTS)) expect(Object.values(w).reduce((s, x) => s + x, 0)).toBe(100);
    for (const d of DIMENSIONS) {
      const avg = (['investor', 'banker', 'dealmaker', 'opportunist'] as const).reduce((s, p) => s + personalityMultipliers(p)[d], 0) / 4;
      expect(avg).toBeCloseTo(1, 12);
    }
    expect(personalityMultipliers('banker').liquidity).toBeGreaterThan(personalityMultipliers('opportunist').liquidity);
    expect(personalityMultipliers('opportunist').market).toBeGreaterThan(personalityMultipliers('banker').market);
  });

  it('a Banker values a reserve-straining purchase less than an Investor does', () => {
    const g = botTable();
    setCash(g, 'Asha', 9000);
    g.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    const investor = decideAs(g, 'Asha', { personality: 'investor' });
    const banker = decideAs(g, 'Asha', { personality: 'banker' });
    expect(investor.considered![0]!.score).toBeGreaterThan(banker.considered![0]!.score);
  });
});

describe('information boundary', () => {
  it('with hidden finances a bot sees only its own cash, loans, credit and objective', () => {
    const g = botTable(undefined, NORMAL, { mode: 'intermediate', config: { financialPrivacy: 'hidden', secretObjectives: true } });
    const obs = observe(g.state, g.id('Asha'), g.nowMs);
    for (const p of obs.state.players) {
      if (p.name !== 'Asha') expect(p.balance).toBe(0);
    }
    expect(obs.me.balance).toBe(25000);
    expect(Object.values(obs.opponentCash).every((c) => !c.known)).toBe(true);
    expect(Object.keys(obs.state.objectives?.assignments ?? {})).toEqual([g.id('Asha')]);
    expect(Object.keys(obs.state.intermediate?.credit ?? {})).toEqual([g.id('Asha')]);
  });

  it('a bot’s decision cannot depend on an opponent’s hidden cash', () => {
    const g = botTable(undefined, NORMAL, { config: { financialPrivacy: 'hidden' } });
    g.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    const rich = structuredClone(g.state);
    rich.players = rich.players.map((p) => (p.name === 'Bilal' ? { ...p, balance: 999_000 } : p));
    const a = decideAs(g, 'Asha', { difficulty: 'hard' });
    g.state = rich;
    const b = decideAs(g, 'Asha', { difficulty: 'hard' });
    expect(b).toEqual(a);
    expect(observe(rich, g.id('Asha'), g.nowMs).state.players.find((p) => p.name === 'Bilal')!.balance).toBe(0);
  });

  it('with open finances the real figures are known', () => {
    const g = botTable();
    const obs = observe(g.state, g.id('Asha'), g.nowMs);
    expect(obs.opponentCash[g.id('Bilal')]).toEqual({ amount: 25000, known: true });
  });
});

describe('decisions on every phase', () => {
  it('rolls at the start of its turn and ends it when nothing is worth more', () => {
    const g = botTable();
    expect(decideAs(g, 'Asha').action).toEqual({ type: 'ROLL_DICE' });
    expect(decideAs(g, 'Bilal').action).toBeNull();
    g.landOn('Asha', positionOfSpecial('START'), 2);
    let guard = 0;
    while (g.state.turn.playerId === g.id('Asha') && guard++ < 30) {
      const d = decideAs(g, 'Asha');
      if (!d.action) break;
      g.act('Asha', d.action);
    }
    expect(g.state.turn.playerId).toBe(g.id('Bilal'));
  });

  it('pays what it owes when it can', () => {
    const g = botTable();
    g.give('Bilal', 'MUMBAI');
    g.landOn('Asha', positionOfProperty('MUMBAI'), 3);
    expect(decideAs(g, 'Asha').action).toEqual({ type: 'PAY_RENT' });
  });

  it('raises money the least harmful way, then pays, and stays in the game', () => {
    const g = botTable();
    g.give('Bilal', 'MUMBAI', { hotel: true });
    g.give('Asha', 'DELHI');
    g.give('Asha', 'CALCUTTA', { houses: 3 });
    setCash(g, 'Asha', 100);
    g.landOn('Asha', positionOfProperty('MUMBAI'), 3);
    const first = decideAs(g, 'Asha');
    expect(first.kind).toBe('RECOVER');
    expect(['SELL_PROPERTY', 'SELL_BUILDING']).not.toContain(first.action?.type);
    let guard = 0;
    while (g.state.turn.phase === 'AWAITING_PAYMENT' && guard++ < 20) g.act('Asha', decideAs(g, 'Asha').action!);
    expect(g.player('Asha').status).toBe('ACTIVE');
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('declares bankruptcy only when even liquidation and every loan could not cover the debt', () => {
    const g = botTable(undefined, NORMAL, { config: { loanLimit: 5000 } });
    g.give('Bilal', 'MUMBAI', { hotel: true });
    setCash(g, 'Asha', 0);
    g.landOn('Asha', positionOfProperty('MUMBAI'), 3);
    expect(decideAs(g, 'Asha').action).toEqual({ type: 'DECLARE_BANKRUPTCY' });
  });

  it('declines a property it can’t afford, and passes in the auction it can’t bid in', () => {
    const g = botTable();
    setCash(g, 'Asha', 500);
    g.landOn('Asha', positionOfProperty('AIR_INDIA'), 4);
    const d = decideAs(g, 'Asha');
    expect(d.action).toEqual({ type: 'DECLINE_PROPERTY' });
    g.act('Asha', d.action!);
    setCash(g, 'Bilal', 50);
    expect(decideAs(g, 'Bilal').action?.type).toBe('PASS_AUCTION');
  });

  it('bids legally: at least the minimum, never above its cash or its maximum, and closes a timed-out auction', () => {
    const g = botTable();
    g.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    const auction = g.state.auction!;
    const d = decideAs(g, 'Bilal');
    expect(d.action?.type).toBe('PLACE_BID');
    const amount = (d.action as Extract<GameAction, { type: 'PLACE_BID' }>).amount;
    expect(amount).toBeGreaterThanOrEqual(auction.minimumOpeningBid);
    const vc = context(g, 'Bilal');
    const max = maximumBid(vc, assess(vc, g.state), auction);
    expect(amount).toBeLessThanOrEqual(max);
    expect(max).toBeLessThanOrEqual(g.balance('Bilal'));
    g.act('Bilal', d.action!);
    // A higher bid than its maximum makes it pass.
    setCash(g, 'Chitra', 100_000);
    g.act('Chitra', { type: 'PLACE_BID', auctionId: auction.id, amount: max + 1000 });
    expect(decideAs(g, 'Bilal').action?.type).toBe('PASS_AUCTION');
    g.advance(60);
    expect(decideAs(g, 'Dev').action).toEqual({ type: 'CLOSE_AUCTION', auctionId: auction.id });
  });

  it('accepts a trade that completes a set at a fair price, and rejects (or counters) one that strips it', () => {
    const g = botTable();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'CALCUTTA');
    g.give('Bilal', 'AHMEDABAD');
    g.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: g.id('Asha'), offeredPropertyKeys: ['AHMEDABAD'], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 4000 });
    expect(decideAs(g, 'Asha').action?.type).toBe('ACCEPT_TRADE');

    const h = botTable();
    h.give('Asha', 'MUMBAI');
    h.act('Bilal', { type: 'CREATE_TRADE', toPlayerId: h.id('Asha'), offeredPropertyKeys: [], requestedPropertyKeys: ['MUMBAI'], offeredMoney: 100, requestedMoney: 0 });
    expect(decideAs(h, 'Asha', { difficulty: 'easy' }).action?.type).toBe('REJECT_TRADE');
    const normal = decideAs(h, 'Asha', { difficulty: 'normal' });
    expect(['REJECT_TRADE', 'CREATE_TRADE']).toContain(normal.action?.type);
    if (normal.action?.type === 'CREATE_TRADE') {
      expect(normal.action.requestedMoney).toBeGreaterThan(0);
      // Countered once: after the counter it rejects the original, and never counters the same exchange again.
      h.act('Asha', normal.action);
      expect(decideAs(h, 'Asha').action?.type).toBe('REJECT_TRADE');
    }
  });

  it('a Deal Maker proposes a set-completing trade on its turn, and never repeats a rejected one', () => {
    const g = botTable(undefined, { difficulty: 'normal', personality: 'dealmaker' });
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'CALCUTTA');
    g.give('Bilal', 'AHMEDABAD');
    g.landOn('Asha', positionOfSpecial('START'), 2); // a quiet square: nothing to pay
    const proposals: GameAction[] = [];
    let guard = 0;
    while (g.state.turn.playerId === g.id('Asha') && guard++ < 30) {
      const d = decideAs(g, 'Asha');
      if (!d.action) break;
      if (d.action.type === 'CREATE_TRADE') proposals.push(d.action);
      if (d.action.type === 'END_TURN' || g.state.turn.phase !== 'TURN_COMPLETE') {
        g.act('Asha', d.action);
        continue;
      }
      g.act('Asha', d.action);
      const pending = g.state.trades.find((t) => t.status === 'PENDING' && t.fromPlayerId === g.id('Asha'));
      if (pending) g.act('Bilal', { type: 'REJECT_TRADE', tradeId: pending.id });
    }
    expect(proposals.length).toBeGreaterThan(0);
    const keys = proposals.map((p) => JSON.stringify([(p as { toPlayerId: string }).toPlayerId, (p as { requestedPropertyKeys: string[] }).requestedPropertyKeys, (p as { offeredPropertyKeys: string[] }).offeredPropertyKeys]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('remembers a rejected offer beyond the trades the game keeps, and never makes it again', () => {
    const g = botTable(undefined, { difficulty: 'normal', personality: 'dealmaker' });
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'CALCUTTA');
    g.give('Bilal', 'AHMEDABAD');
    g.landOn('Asha', positionOfSpecial('START'), 2);
    let proposal: Extract<GameAction, { type: 'CREATE_TRADE' }> | null = null;
    let guard = 0;
    while (!proposal && g.state.turn.playerId === g.id('Asha') && guard++ < 30) {
      const d = decideAs(g, 'Asha');
      if (!d.action || d.action.type === 'END_TURN') break;
      if (d.action.type === 'CREATE_TRADE') proposal = d.action;
      else g.act('Asha', d.action);
    }
    expect(proposal).not.toBeNull();
    g.act('Asha', proposal!);
    const offer = g.state.trades.find((t) => t.status === 'PENDING' && t.fromPlayerId === g.id('Asha'))!;
    g.act(g.state.players.find((p) => p.id === offer.toPlayerId)!.name, { type: 'REJECT_TRADE', tradeId: offer.id });
    expect(g.state.botTradeMemory?.[g.id('Asha')]).toEqual([tradeSignature(offer)]);
    // The game keeps only its most recent trades: forget every one of them. The memory still holds.
    g.state = { ...g.state, trades: [] };
    const again = decideAs(g, 'Asha').action;
    expect(again?.type === 'CREATE_TRADE' && tradeSignature(again) === tradeSignature(offer)).toBe(false);
  });

  it('a person’s rejected offer is not a bot’s memory', () => {
    const g = botTable(['Asha', 'Bilal', 'Chitra']);
    g.state = { ...g.state, players: g.state.players.map((p) => (p.name === 'Asha' ? { ...p, bot: null } : p)) };
    g.give('Bilal', 'AHMEDABAD');
    g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: [], requestedPropertyKeys: ['AHMEDABAD'], offeredMoney: 1000, requestedMoney: 0 });
    g.act('Bilal', { type: 'REJECT_TRADE', tradeId: g.state.trades[0]!.id });
    expect(g.state.botTradeMemory ?? {}).toEqual({});
  });

  it('wakes up when a person’s resale opens for bids, and bids then', () => {
    const g = botTable(['Asha', 'Bilal', 'Chitra'], { difficulty: 'normal', personality: 'opportunist' }, { mode: 'intermediate' });
    g.state = { ...g.state, players: g.state.players.map((p) => (p.name === 'Asha' ? { ...p, bot: null } : p)) };
    g.give('Asha', 'MUMBAI');
    g.act('Asha', { type: 'START_RESALE_AUCTION', propertyKey: 'MUMBAI', reservePrice: 1000 });
    const auction = g.state.auction!;
    // During the "get ready" countdown no bot may bid, and nothing else will happen when it ends…
    expect(nextBotMove(g.state, { nowMs: g.nowMs })).toBeNull();
    // …so the runners are told when to look again,
    expect(nextBotWakeAt(g.state, g.nowMs)).toBe(auctionOpensAt(auction));
    // and then a bot bids.
    expect(nextBotMove(g.state, { nowMs: auctionOpensAt(auction) })?.action.type).toBe('PLACE_BID');
    expect(nextBotWakeAt(g.state, auctionOpensAt(auction))).toBeNull();
  });

  it('chooses a legal alternative when its preferred action is refused', () => {
    const g = botTable();
    g.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    expect(decideAs(g, 'Asha').action).toEqual({ type: 'BUY_PROPERTY' });
    expect(decideAs(g, 'Asha', undefined, { exclude: [actionKey({ type: 'BUY_PROPERTY' })] }).action).toEqual({ type: 'DECLINE_PROPERTY' });
  });

  it('chooses in Jail between the fine and staying, always legally', () => {
    const g = botTable();
    g.landOn('Asha', positionOfSpecial('JAIL'), 9);
    g.act('Asha', { type: 'END_TURN' });
    for (const n of ['Bilal', 'Chitra', 'Dev']) {
      g.rollTotal(n, 2);
      let guard = 0;
      while (g.state.turn.playerId === g.id(n) && guard++ < 20) g.act(n, decideAs(g, n).action!);
    }
    expect(g.player('Asha').inJail).toBe(true);
    expect(['PAY_JAIL_FINE', 'STAY_IN_JAIL']).toContain(decideAs(g, 'Asha').action?.type);
  });

  it('votes on ending the game by its own estimate of the standings', () => {
    const g = botTable();
    g.act('Asha', { type: 'REQUEST_END_VOTE' });
    const d = decideAs(g, 'Bilal');
    expect(d.action?.type).toBe('CAST_END_VOTE');
    // Level with everyone: no lead, so it votes to continue.
    expect((d.action as Extract<GameAction, { type: 'CAST_END_VOTE' }>).choice).toBe('CONTINUE');
  });

  it('declines an undo that would take back money it received', () => {
    const t = botTable();
    t.give('Bilal', 'MUMBAI');
    t.landOn('Asha', positionOfProperty('MUMBAI'), 3);
    t.act('Asha', { type: 'PAY_RENT' });
    const top = topUndoable(t.state)!;
    t.act('Asha', { type: 'REQUEST_UNDO', targetActionId: top.actionId });
    expect(decideAs(t, 'Bilal').action?.type).toBe('REJECT_UNDO');
  });

  it('is deterministic: the same state, seat and seed give the same decision', () => {
    const g = botTable();
    g.landOn('Asha', positionOfProperty('AHMEDABAD'), 4);
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      expect(decideAs(g, 'Asha', { difficulty })).toEqual(decideAs(g, 'Asha', { difficulty }));
    }
  });
});
