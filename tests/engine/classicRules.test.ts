/** Finalized Classic Mode rules: Jail, Rest House, Club, Income Tax, Wealth Taxes, 5-second auctions. */
import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, incomeTaxDue, PROPERTY_KEYS, positionOfSpecial, wealthTaxDue, type PropertyKey } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;
const JAIL = positionOfSpecial('JAIL');
const CLUB = positionOfSpecial('CLUB');
const REST_HOUSE = positionOfSpecial('REST_HOUSE');
const INCOME_TAX = positionOfSpecial('INCOME_TAX');
const WEALTH_TAX = positionOfSpecial('WEALTH_TAX');

/** A turn that moves no money: Wealth Taxes with no buildings. */
function quietTurn(g: TestGame, who: string) {
  g.landOn(who, WEALTH_TAX, 4);
  g.act(who, { type: 'END_TURN' });
}

/** Asha lands on Jail and ends her turn; Bilal and Chitra take quiet turns, so it is Asha's turn again (in Jail). */
function jailedAsha() {
  const g = new TestGame();
  g.landOn('Asha', JAIL, 4);
  g.act('Asha', { type: 'END_TURN' });
  quietTurn(g, 'Bilal');
  quietTurn(g, 'Chitra');
  expect(g.current).toBe('Asha');
  return g;
}

describe('Jail', () => {
  it('rules: up to 3 turns, ₹500 to leave', () => {
    expect(BUSINESS_MVP_RULES.jail).toEqual({ maxTurns: 3, fine: 500 });
  });

  it('landing on Jail by a roll sends the player to Jail', () => {
    const g = new TestGame();
    const r = g.landOn('Asha', JAIL, 4);
    expect(g.player('Asha')).toMatchObject({ position: JAIL, inJail: true, jailTurnsLeft: 3, skipTurns: 0 });
    expect(r.events.some((e) => e.type === 'SENT_TO_JAIL')).toBe(true);
    expect(r.transactions).toHaveLength(0);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('a Go to Jail card sends the player to Jail the same way', () => {
    const g = new TestGame();
    g.landOn('Asha', positionOfSpecial('CHANCE'), 10); // Chance even 10: Go to Jail
    expect(g.player('Asha')).toMatchObject({ position: JAIL, inJail: true, jailTurnsLeft: 3 });
  });

  it('a jailed player gets their turn but cannot roll — there is no doubles escape', () => {
    const g = jailedAsha();
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', playerId: g.id('Asha') });
    for (const [a, b] of [
      [6, 6],
      [1, 1],
      [2, 5],
    ] as const) {
      expect(() => g.roll('Asha', a, b)).toThrow("You're in Jail — pay ₹500 to leave, or stay this turn.");
    }
    expect(g.player('Asha')).toMatchObject({ position: JAIL, inJail: true, jailTurnsLeft: 3 });
  });

  it('staying misses the turn; after the third missed turn the player is released exactly once', () => {
    const g = jailedAsha();
    const released: string[] = [];
    for (const left of [2, 1]) {
      const r = g.act('Asha', { type: 'STAY_IN_JAIL' });
      expect(r.transactions).toHaveLength(0);
      expect(g.player('Asha')).toMatchObject({ inJail: true, jailTurnsLeft: left, position: JAIL });
      expect(g.current).toBe('Bilal'); // turn passed on
      quietTurn(g, 'Bilal');
      quietTurn(g, 'Chitra');
      released.push(...r.events.filter((e) => e.type === 'JAIL_RELEASED').map((e) => e.id));
    }
    const last = g.act('Asha', { type: 'STAY_IN_JAIL' });
    released.push(...last.events.filter((e) => e.type === 'JAIL_RELEASED').map((e) => e.id));
    expect(released).toHaveLength(1);
    expect(g.player('Asha')).toMatchObject({ inJail: false, jailTurnsLeft: 0, position: JAIL });
    expect(g.balance('Asha')).toBe(START); // waiting is free
    quietTurn(g, 'Bilal');
    quietTurn(g, 'Chitra');
    // Fourth turn: free — rolls and moves normally.
    expect(() => g.act('Asha', { type: 'STAY_IN_JAIL' })).toThrow("You're not in Jail.");
    g.roll('Asha', 1, 2);
    expect(g.player('Asha').position).toBe(JAIL + 3);
  });

  it('paying ₹500 releases immediately and the player rolls this turn', () => {
    const g = jailedAsha();
    const r = g.act('Asha', { type: 'PAY_JAIL_FINE' });
    expect(r.transactions).toMatchObject([{ type: 'JAIL_FINE', amount: 500, fromPlayerId: g.id('Asha'), toPlayerId: null }]);
    expect(g.balance('Asha')).toBe(START - 500);
    expect(g.player('Asha')).toMatchObject({ inJail: false, jailTurnsLeft: 0 });
    expect(g.state.turn).toMatchObject({ phase: 'AWAITING_ROLL', playerId: g.id('Asha') });
    // Can't pay twice.
    expect(() => g.act('Asha', { type: 'PAY_JAIL_FINE' })).toThrow("You're not in Jail.");
    expect(g.ledger.filter((t) => t.type === 'JAIL_FINE')).toHaveLength(1);
    g.roll('Asha', 1, 2);
    expect(g.player('Asha').position).toBe(JAIL + 3);
  });

  it('can pay on a later Jail turn after staying', () => {
    const g = jailedAsha();
    g.act('Asha', { type: 'STAY_IN_JAIL' });
    quietTurn(g, 'Bilal');
    quietTurn(g, 'Chitra');
    g.act('Asha', { type: 'PAY_JAIL_FINE' });
    expect(g.player('Asha')).toMatchObject({ inJail: false, jailTurnsLeft: 0 });
    expect(g.balance('Asha')).toBe(START - 500);
  });

  it('not enough money: paying is rejected with nothing changed, staying still works', () => {
    const g = jailedAsha();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 400 });
    const before = structuredClone(g.state);
    expect(() => g.act('Asha', { type: 'PAY_JAIL_FINE' })).toThrow('Not enough money — leaving Jail costs ₹500.');
    expect(g.state).toEqual(before);
    g.act('Asha', { type: 'STAY_IN_JAIL' });
    expect(g.player('Asha')).toMatchObject({ inJail: true, jailTurnsLeft: 2, balance: 400 });
  });

  it('only the jailed player, on their own turn, at the start of it', () => {
    const g = new TestGame();
    g.landOn('Asha', JAIL, 4);
    // Asha's landing turn is not a Jail turn.
    expect(() => g.act('Asha', { type: 'STAY_IN_JAIL' })).toThrow('You can only choose at the start of your turn.');
    expect(() => g.act('Asha', { type: 'PAY_JAIL_FINE' })).toThrow('You can only leave Jail at the start of your turn.');
    g.act('Asha', { type: 'END_TURN' });
    expect(() => g.act('Asha', { type: 'PAY_JAIL_FINE' })).toThrow("It's not your turn.");
    expect(() => g.act('Bilal', { type: 'STAY_IN_JAIL' })).toThrow("You're not in Jail.");
  });

  it("a jailed player's properties keep earning rent", () => {
    const g = new TestGame();
    g.give('Asha', 'DELHI');
    g.landOn('Asha', JAIL, 4);
    g.act('Asha', { type: 'END_TURN' });
    g.placeBefore('Bilal', 'DELHI', 1 + 1);
    g.roll('Bilal', 1, 1); // Jail + 1 = Delhi
    expect(g.state.turn.pending).toMatchObject({ reason: 'RENT', toPlayerId: g.id('Asha') });
    g.act('Bilal', { type: 'PAY_RENT' });
    expect(g.balance('Asha')).toBeGreaterThan(START);
  });

  it('landing on Jail no longer means "just visiting"', () => {
    const g = new TestGame();
    const r = g.landOn('Asha', JAIL, 4);
    expect(r.events.some((e) => e.type === 'JUST_VISITING')).toBe(false);
  });
});

describe('Rest House', () => {
  it('3 players: collects ₹100 from each other player (₹200), atomically, then skips the next turn', () => {
    const g = new TestGame();
    const r = g.landOn('Asha', REST_HOUSE, 6);
    const collected = r.transactions.filter((t) => t.type === 'REST_HOUSE_COLLECTION');
    expect(collected).toHaveLength(2);
    expect(collected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromPlayerId: g.id('Bilal'), toPlayerId: g.id('Asha'), amount: 100 }),
        expect.objectContaining({ fromPlayerId: g.id('Chitra'), toPlayerId: g.id('Asha'), amount: 100 }),
      ]),
    );
    expect(g.balance('Asha')).toBe(START + 200);
    expect(g.balance('Bilal')).toBe(START - 100);
    expect(g.balance('Chitra')).toBe(START - 100);
    expect(g.player('Asha').skipTurns).toBe(1);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');

    g.act('Asha', { type: 'END_TURN' });
    quietTurn(g, 'Bilal');
    const r2 = g.landOn('Chitra', WEALTH_TAX, 4);
    expect(r2.transactions).toHaveLength(0);
    const end = g.act('Chitra', { type: 'END_TURN' });
    expect(end.events.some((e) => e.type === 'TURN_SKIPPED' && e.actorId === g.id('Asha'))).toBe(true);
    expect(g.current).toBe('Bilal'); // Asha's turn skipped
    expect(g.player('Asha').skipTurns).toBe(0);
  });

  it('2 players: collects ₹100', () => {
    const g = new TestGame(['Asha', 'Bilal']);
    g.landOn('Asha', REST_HOUSE, 6);
    expect(g.balance('Asha')).toBe(START + 100);
    expect(g.balance('Bilal')).toBe(START - 100);
    g.act('Asha', { type: 'END_TURN' });
    quietTurn(g, 'Bilal');
    expect(g.current).toBe('Bilal'); // Asha skipped, Bilal goes again
  });

  it('4 players: collects ₹300', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    const r = g.landOn('Asha', REST_HOUSE, 6);
    expect(r.transactions.filter((t) => t.type === 'REST_HOUSE_COLLECTION')).toHaveLength(3);
    expect(g.balance('Asha')).toBe(START + 300);
    for (const n of ['Bilal', 'Chitra', 'Dev']) expect(g.balance(n)).toBe(START - 100);
  });

  it('bankrupt players are not charged; a player short of ₹100 pays what they have', () => {
    const g = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    g.player('Dev').status = 'BANKRUPT'; // test setup: out of the game
    g.act('Chitra', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 40 });
    const r = g.landOn('Asha', REST_HOUSE, 6);
    expect(r.transactions.filter((t) => t.type === 'REST_HOUSE_COLLECTION').map((t) => [t.fromPlayerId, t.amount])).toEqual([
      [g.id('Bilal'), 100],
      [g.id('Chitra'), 40],
    ]);
    expect(g.balance('Asha')).toBe(START + 140);
    expect(g.balance('Chitra')).toBe(0);
    expect(r.events.some((e) => e.type === 'REST_HOUSE_SHORTFALL')).toBe(true);
  });
});

describe('Club', () => {
  it('3 players: pays ₹100 to each other player (₹200) in one atomic action; no skipped turn', () => {
    const g = new TestGame();
    g.landOn('Asha', CLUB, 5);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'CLUB', amount: 200, payeeIds: [g.id('Bilal'), g.id('Chitra')] });
    const r = g.act('Asha', { type: 'PAY_CLUB' });
    expect(r.transactions.map((t) => [t.type, t.fromPlayerId, t.toPlayerId, t.amount])).toEqual([
      ['CLUB_PAYMENT', g.id('Asha'), g.id('Bilal'), 100],
      ['CLUB_PAYMENT', g.id('Asha'), g.id('Chitra'), 100],
    ]);
    expect(g.balance('Asha')).toBe(START - 200);
    expect(g.balance('Bilal')).toBe(START + 100);
    expect(g.balance('Chitra')).toBe(START + 100);
    expect(g.player('Asha').skipTurns).toBe(0);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    expect(() => g.act('Asha', { type: 'PAY_CLUB' })).toThrow('There is nothing to pay right now.');
  });

  it('2 players: ₹100; 4 players: ₹300', () => {
    const two = new TestGame(['Asha', 'Bilal']);
    two.landOn('Asha', CLUB, 5);
    two.act('Asha', { type: 'PAY_CLUB' });
    expect(two.balance('Asha')).toBe(START - 100);
    const four = new TestGame(['Asha', 'Bilal', 'Chitra', 'Dev']);
    four.landOn('Asha', CLUB, 5);
    four.act('Asha', { type: 'PAY_CLUB' });
    expect(four.balance('Asha')).toBe(START - 300);
    for (const n of ['Bilal', 'Chitra', 'Dev']) expect(four.balance(n)).toBe(START + 100);
  });

  it('insufficient funds: the normal raise-money / bankruptcy flow applies', () => {
    const g = new TestGame();
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 150 });
    g.landOn('Asha', CLUB, 5);
    expect(() => g.act('Asha', { type: 'PAY_CLUB' })).toThrow('Not enough money — you need ₹200.');
    g.act('Asha', { type: 'REQUEST_LOAN', amount: 1000 });
    g.act('Asha', { type: 'PAY_CLUB' });
    expect(g.balance('Asha')).toBe(150 + 1000 - 200);
  });
});

describe('Income Tax — ₹50 per property, max ₹500', () => {
  it.each([
    [1, 50],
    [3, 150],
    [6, 300],
    [10, 500],
    [12, 500],
  ])('%i properties → %i', (count, amount) => {
    const g = new TestGame();
    for (const key of PROPERTY_KEYS.slice(0, count)) g.give('Asha', key);
    expect(incomeTaxDue(g.state, g.id('Asha'))).toEqual({ properties: count, amount });
    g.landOn('Asha', INCOME_TAX, 5);
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'TAX', amount, toPlayerId: null });
    expect((g.state.turn.pending as { label: string }).label).toBe(
      `Income Tax — ${count} ${count === 1 ? 'property' : 'properties'} × ₹50`,
    );
    const r = g.act('Asha', { type: 'PAY_TAX' });
    expect(r.transactions).toMatchObject([{ type: 'TAX_PAYMENT', amount, fromPlayerId: g.id('Asha'), toPlayerId: null }]);
    expect(g.balance('Asha')).toBe(START - amount);
  });

  it('0 properties → nothing to pay, no transaction', () => {
    const g = new TestGame();
    const r = g.landOn('Asha', INCOME_TAX, 5);
    expect(g.state.turn.pending).toBeNull();
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    expect(r.transactions).toHaveLength(0);
    expect(r.events.some((e) => e.type === 'TAX_NONE')).toBe(true);
  });

  it('counts each owned site once — mortgaged and developed sites included, other players’ sites excluded', () => {
    const g = new TestGame();
    g.give('Asha', 'DELHI', { houses: 3 });
    g.give('Asha', 'MUMBAI', { hotel: true });
    g.give('Asha', 'RAILWAY', { mortgaged: true });
    g.give('Bilal', 'SHIMLA');
    expect(incomeTaxDue(g.state, g.id('Asha'))).toEqual({ properties: 3, amount: 150 });
  });
});

describe('Wealth Taxes — ₹100 per house + ₹200 per hotel, max ₹500', () => {
  const cases: [string, Partial<Record<PropertyKey, { houses?: number; hotel?: boolean }>>, number][] = [
    ['no properties', {}, 0],
    ['undeveloped properties only', { DELHI: {}, MUMBAI: {} }, 0],
    ['2 houses', { DELHI: { houses: 2 } }, 200],
    ['3 houses', { DELHI: { houses: 3 } }, 300],
    ['1 hotel', { MUMBAI: { hotel: true } }, 200],
    ['1 hotel + 2 houses', { MUMBAI: { hotel: true }, DELHI: { houses: 2 } }, 400],
    ['3 houses + 1 hotel', { MUMBAI: { hotel: true }, DELHI: { houses: 3 } }, 500],
    ['5 houses (capped)', { DELHI: { houses: 3 }, SHIMLA: { houses: 2 } }, 500],
    ['2 hotels + 3 houses (capped)', { MUMBAI: { hotel: true }, MADRAS: { hotel: true }, DELHI: { houses: 3 } }, 500],
  ];

  it.each(cases)('%s', (_label, holdings, amount) => {
    const g = new TestGame();
    for (const [key, patch] of Object.entries(holdings)) g.give('Asha', key as PropertyKey, patch);
    g.give('Bilal', 'CALCUTTA', { hotel: true }); // someone else's buildings never count
    expect(wealthTaxDue(g.state, g.id('Asha')).amount).toBe(amount);
    const r = g.landOn('Asha', WEALTH_TAX, 4);
    if (amount === 0) {
      expect(g.state.turn.pending).toBeNull();
      expect(g.state.turn.phase).toBe('TURN_COMPLETE');
      expect(r.transactions).toHaveLength(0);
      return;
    }
    expect(g.state.turn.pending).toMatchObject({ kind: 'PAYMENT', reason: 'TAX', amount, toPlayerId: null });
    const pay = g.act('Asha', { type: 'PAY_TAX' });
    expect(pay.transactions).toMatchObject([{ type: 'TAX_PAYMENT', amount, fromPlayerId: g.id('Asha'), toPlayerId: null }]);
    expect(g.balance('Asha')).toBe(START - amount);
  });

  it('shows what was counted', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { hotel: true });
    g.give('Asha', 'DELHI', { houses: 2 });
    g.landOn('Asha', WEALTH_TAX, 4);
    expect(g.state.turn.pending).toMatchObject({ amount: 400, label: 'Wealth Taxes — 2 houses × ₹100 + 1 hotel × ₹200' });
  });

  it('PAY_TAX no longer accepts a typed-in amount', () => {
    const g = new TestGame();
    g.give('Asha', 'DELHI', { houses: 1 });
    g.landOn('Asha', WEALTH_TAX, 4);
    expect(() => g.act('Asha', { type: 'PAY_TAX', amount: 1 } as never)).toThrow('That action is not valid.');
  });
});

describe('auction — 5-second countdown (server authoritative)', () => {
  function auctionGame() {
    const g = new TestGame();
    g.roll('Asha', 1, 2); // Railway
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    return { g, auction: g.state.auction! };
  }

  it('opens with a 5-second deadline; each bid restarts it at 5 seconds', () => {
    expect(BUSINESS_MVP_RULES.auction.openingTimerSeconds).toBe(5);
    expect(BUSINESS_MVP_RULES.auction.bidTimerSeconds).toBe(5);
    const { g, auction } = auctionGame();
    expect(Date.parse(auction.endsAt) - Date.parse(auction.createdAt)).toBe(5000);
    g.advance(4);
    g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: 500 });
    expect(Date.parse(g.state.auction!.endsAt)).toBe(g.nowMs + 5000);
  });

  it('a bid at exactly the deadline counts; a bid after it is rejected; CLOSE only after it, exactly once', () => {
    const { g, auction } = auctionGame();
    g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: 500 });
    g.advance(4.999);
    expect(() => g.act('Asha', { type: 'CLOSE_AUCTION', auctionId: auction.id })).toThrow('The auction is still running.');
    g.advance(0.001); // exactly at the deadline
    g.act('Chitra', { type: 'PLACE_BID', auctionId: auction.id, amount: 600 });
    g.advance(5.001);
    expect(() => g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: 700 })).toThrow('Bidding has ended.');
    const close = g.act('Asha', { type: 'CLOSE_AUCTION', auctionId: auction.id });
    expect(close.transactions).toMatchObject([{ type: 'AUCTION_PAYMENT', amount: 600, fromPlayerId: g.id('Chitra') }]);
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Chitra'));
    expect(() => g.act('Bilal', { type: 'CLOSE_AUCTION', auctionId: auction.id })).toThrow(/no longer running|has finished/);
    expect(g.ledger.filter((t) => t.type === 'AUCTION_PAYMENT')).toHaveLength(1);
  });

  it('no bids within 5 seconds → closes unsold', () => {
    const { g, auction } = auctionGame();
    g.advance(5.001);
    expect(() => g.act('Bilal', { type: 'PLACE_BID', auctionId: auction.id, amount: 100 })).toThrow('Bidding has ended.');
    g.act('Bilal', { type: 'CLOSE_AUCTION', auctionId: auction.id });
    expect(g.state.auction).toMatchObject({ status: 'CLOSED', winnerId: null });
    expect(g.state.properties.RAILWAY.ownerId).toBeNull();
  });
});
