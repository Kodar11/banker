import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, positionOfSpecial, type GameAction, type PropertyKey } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;

function offer(
  g: TestGame,
  from: string,
  to: string,
  give: { keys?: PropertyKey[]; money?: number },
  want: { keys?: PropertyKey[]; money?: number },
) {
  const action: GameAction = {
    type: 'CREATE_TRADE',
    toPlayerId: g.id(to),
    offeredPropertyKeys: give.keys ?? [],
    requestedPropertyKeys: want.keys ?? [],
    offeredMoney: give.money ?? 0,
    requestedMoney: want.money ?? 0,
  };
  g.act(from, action);
  return g.state.trades.at(-1)!;
}

describe('trade offers — create, accept, reject, cancel', () => {
  it('Property A ↔ Property B', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { keys: ['DELHI'] });
    expect(t).toMatchObject({ status: 'PENDING', fromPlayerId: g.id('Asha'), toPlayerId: g.id('Bilal') });
    // Creating changes nothing yet.
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    const r = g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Bilal'));
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Asha'));
    expect(r.transactions).toHaveLength(0);
    expect(r.events[0]).toMatchObject({ type: 'TRADE_ACCEPTED', payload: { tradeId: t.id, offeredPropertyKeys: ['MUMBAI'], requestedPropertyKeys: ['DELHI'] } });
    expect(g.state.trades.find((x) => x.id === t.id)?.status).toBe('ACCEPTED');
  });

  it('Property A + ₹2,000 ↔ Property B', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE');
    g.give('Bilal', 'DELHI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['INDORE'], money: 2000 }, { keys: ['DELHI'] });
    const r = g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(r.transactions).toMatchObject([{ type: 'TRADE_PAYMENT', fromPlayerId: g.id('Asha'), toPlayerId: g.id('Bilal'), amount: 2000 }]);
    expect(g.balance('Asha')).toBe(START - 2000);
    expect(g.balance('Bilal')).toBe(START + 2000);
    expect(g.state.properties.INDORE.ownerId).toBe(g.id('Bilal'));
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Asha'));
  });

  it('Property A ↔ ₹5,000 (custom amount)', () => {
    const g = new TestGame();
    g.give('Asha', 'RAILWAY');
    const t = offer(g, 'Asha', 'Chitra', { keys: ['RAILWAY'] }, { money: 5000 });
    g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(g.state.properties.RAILWAY.ownerId).toBe(g.id('Chitra'));
    expect(g.balance('Asha')).toBe(START + 5000);
    expect(g.balance('Chitra')).toBe(START - 5000);
  });

  it('Property A + Property B + ₹3,000 ↔ Property C', () => {
    const g = new TestGame();
    g.give('Asha', 'AGRA');
    g.give('Asha', 'PATNA');
    g.give('Bilal', 'MADRAS');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['AGRA', 'PATNA'], money: 3000 }, { keys: ['MADRAS'] });
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(g.state.properties.AGRA.ownerId).toBe(g.id('Bilal'));
    expect(g.state.properties.PATNA.ownerId).toBe(g.id('Bilal'));
    expect(g.state.properties.MADRAS.ownerId).toBe(g.id('Asha'));
    expect(g.balance('Asha')).toBe(START - 3000);
  });

  it('works off-turn and the mortgage travels with the property', () => {
    const g = new TestGame();
    g.give('Bilal', 'COCHIN', { mortgaged: true });
    const t = offer(g, 'Bilal', 'Chitra', { keys: ['COCHIN'] }, { money: 100 });
    g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(g.state.properties.COCHIN).toMatchObject({ ownerId: g.id('Chitra'), mortgaged: true });
  });

  it('reject (recipient) and cancel (creator) change nothing else', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    const t1 = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 9000 });
    expect(() => g.act('Asha', { type: 'REJECT_TRADE', tradeId: t1.id })).toThrow(/Only the player this offer was made to/);
    g.act('Bilal', { type: 'REJECT_TRADE', tradeId: t1.id });
    expect(g.state.trades.find((x) => x.id === t1.id)?.status).toBe('REJECTED');
    const t2 = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 9000 });
    expect(() => g.act('Bilal', { type: 'CANCEL_TRADE', tradeId: t2.id })).toThrow(/Only the player who made the offer/);
    g.act('Asha', { type: 'CANCEL_TRADE', tradeId: t2.id });
    expect(g.state.trades.find((x) => x.id === t2.id)?.status).toBe('CANCELLED');
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t2.id })).toThrow('This offer was already cancelled.');
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
    expect(g.balance('Asha')).toBe(START);
  });

  it('only the recipient can accept; a trade executes once', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 1000 });
    expect(() => g.act('Asha', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow(/Only the player this offer was made to/);
    expect(() => g.act('Chitra', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow(/Only the player this offer was made to/);
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow('This offer was already accepted.');
    expect(g.ledger.filter((x) => x.type === 'TRADE_PAYMENT')).toHaveLength(1);
  });
});

describe('trade validation', () => {
  it('rejects invalid offers at creation', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI');
    const bad = (from: string, to: string, give: { keys?: PropertyKey[]; money?: number }, want: { keys?: PropertyKey[]; money?: number }) =>
      () => offer(g, from, to, give, want);
    expect(bad('Asha', 'Asha', { keys: ['MUMBAI'] }, { money: 10 })).toThrow('Choose another player.');
    expect(bad('Asha', 'Bilal', { keys: ['DELHI'] }, { money: 10 })).toThrow('Delhi no longer belongs to that player.');
    expect(bad('Asha', 'Bilal', { keys: ['MUMBAI'] }, { keys: ['AGRA'] })).toThrow('Agra no longer belongs to that player.');
    expect(bad('Asha', 'Bilal', { money: 500 }, { money: 100 })).toThrow('A trade must include at least one property.');
    expect(bad('Asha', 'Bilal', { keys: ['MUMBAI'] }, {})).toThrow('Ask for something in return.');
    expect(bad('Asha', 'Bilal', {}, { keys: ['DELHI'] })).toThrow('Offer something.');
    expect(bad('Asha', 'Bilal', { keys: ['MUMBAI'], money: START + 1 }, { keys: ['DELHI'] })).toThrow("Asha doesn't have the offered money.");
    expect(bad('Asha', 'Bilal', { keys: ['MUMBAI', 'MUMBAI'] }, { keys: ['DELHI'] })).toThrow('A property can only appear once in a trade.');
    g.give('Asha', 'MUMBAI', { houses: 1 });
    expect(bad('Asha', 'Bilal', { keys: ['MUMBAI'] }, { keys: ['DELHI'] })).toThrow('Sell the buildings on Mumbai before trading it.');
    expect(g.state.trades).toHaveLength(0);
  });

  it('negative or fractional money is rejected by the schema', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    expect(() => offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: -5 })).toThrow('That action is not valid.');
    expect(() => offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 10.5 })).toThrow('That action is not valid.');
  });

  it('accept re-validates: property sold to the bank since → fails and NOTHING changes', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'], money: 1000 }, { keys: ['DELHI'] });
    g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' });
    const ledger = g.ledger.length;
    const balances = g.state.players.map((p) => p.balance);
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow(/Mumbai no longer belongs to that player/);
    expect(g.ledger).toHaveLength(ledger);
    expect(g.state.players.map((p) => p.balance)).toEqual(balances);
    expect(g.state.properties.DELHI.ownerId).toBe(g.id('Bilal'));
    expect(g.state.trades.find((x) => x.id === t.id)?.status).toBe('PENDING');
  });

  it('accept re-validates money: requested money no longer available → fails atomically', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 20000 });
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 10000 });
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow("Trade can't go through: Bilal doesn't have the requested money.");
    expect(g.state.properties.MUMBAI.ownerId).toBe(g.id('Asha'));
  });

  it('accept re-validates money: offered money spent since → fails', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Bilal', 'DELHI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'], money: 20000 }, { keys: ['DELHI'] });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: 10000 });
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow(/Asha doesn't have the offered money/);
  });

  it('accept re-validates buildings added since', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 100 });
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow(/Sell the buildings on Mumbai/);
  });

  it('offers involving a bankrupt player expire', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['INDORE'] }, { money: 100 });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 100 });
    g.landOn('Asha', positionOfSpecial('CLUB'), 5); // Club ₹100 × 2 players > ₹100
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state.trades.find((x) => x.id === t.id)?.status).toBe('EXPIRED');
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow('This offer was already expired.');
  });

  it('trades are blocked while paused', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['INDORE'] }, { money: 100 });
    g.act('Chitra', { type: 'PAUSE_GAME' });
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow('Game is paused.');
  });
});
