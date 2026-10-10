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

  it('a house built after the offer closes it: the deal shown is no longer the deal', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['MUMBAI'] }, { money: 100 });
    const r = g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'MUMBAI' });
    expect(g.state.trades.find((x) => x.id === t.id)!.status).toBe('EXPIRED');
    expect(r.events.find((e) => e.type === 'TRADE_EXPIRED')!.message).toBe('Trade offer from Asha to Bilal closed — Mumbai changed');
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id })).toThrow('This offer was already expired.');
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Asha'), houses: 1 });
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

describe('trading a property with buildings — the buildings go with it', () => {
  const built: [string, { houses: number; hotel: boolean }, string][] = [
    ['one house', { houses: 1, hotel: false }, 'Shimla (1 house)'],
    ['two houses', { houses: 2, hotel: false }, 'Shimla (2 houses)'],
    ['three houses', { houses: 3, hotel: false }, 'Shimla (3 houses)'],
    ['a hotel', { houses: 0, hotel: true }, 'Shimla (hotel)'],
  ];

  it('the rule set allows it', () => {
    expect(BUSINESS_MVP_RULES.trades).toMatchObject({ requireNoBuildings: false, allowMortgaged: true });
  });

  it.each(built)('%s: offered, named in the log, and transferred exactly as built', (_label, patch, label) => {
    const g = new TestGame();
    g.give('Asha', 'SHIMLA', patch);
    g.give('Bilal', 'AGRA');
    const t = offer(g, 'Asha', 'Bilal', { keys: ['SHIMLA'] }, { keys: ['AGRA'], money: 500 });
    expect(g.results.at(-1)!.events.find((e) => e.type === 'TRADE_OFFERED')!.message).toBe(`Asha offered Bilal: ${label} ⇄ Agra + ₹500`);
    const r = g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(r.events.find((e) => e.type === 'TRADE_ACCEPTED')!.message).toBe(`Bilal accepted: Asha gave ${label} for Agra + ₹500`);
    expect(g.state.properties.SHIMLA).toEqual({ key: 'SHIMLA', ownerId: g.id('Bilal'), mortgaged: false, ...patch });
    expect(g.state.properties.AGRA).toMatchObject({ ownerId: g.id('Asha'), houses: 0, hotel: false });
    // Only the agreed money moved: the buildings are neither paid for nor refunded.
    expect(r.transactions.map((x) => [x.type, x.amount])).toEqual([['TRADE_PAYMENT', 500]]);
    expect(g.balance('Asha')).toBe(START + 500);
    expect(g.balance('Bilal')).toBe(START - 500);
  });

  it('the new owner collects the rent of the buildings, and can sell them', () => {
    const g = new TestGame();
    g.give('Asha', 'SHIMLA', { houses: 2 }); // rent with 2 houses 2,750; house cost 3,500
    const t = offer(g, 'Asha', 'Bilal', { keys: ['SHIMLA'] }, { money: 1000 });
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    g.placeBefore('Asha', 'SHIMLA', 4);
    g.roll('Asha', 2, 2);
    expect(g.state.turn.pending).toMatchObject({ reason: 'RENT', amount: 2750, toPlayerId: g.id('Bilal') });
    g.act('Bilal', { type: 'SELL_BUILDING', propertyKey: 'SHIMLA' });
    expect(g.balance('Bilal')).toBe(START - 1000 + 1750);
  });

  it('a mortgaged property with buildings is traded with both', () => {
    const g = new TestGame();
    g.give('Asha', 'SHIMLA', { hotel: true, mortgaged: true });
    const t = offer(g, 'Asha', 'Bilal', { keys: ['SHIMLA'] }, { money: 100 });
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    expect(g.state.properties.SHIMLA).toEqual({ key: 'SHIMLA', ownerId: g.id('Bilal'), houses: 0, hotel: true, mortgaged: true });
  });

  it.each([
    ['selling a house', { houses: 2 }, 'SELL_BUILDING'],
    ['mortgaging it', { houses: 2 }, 'MORTGAGE_PROPERTY'],
    ['unmortgaging it', { houses: 2, mortgaged: true }, 'UNMORTGAGE_PROPERTY'],
  ] as const)('%s after the offer closes the offer, on either side of the trade', (_label, patch, type) => {
    const g = new TestGame();
    g.give('Asha', 'SHIMLA', patch);
    g.give('Bilal', 'AGRA');
    const mine = offer(g, 'Asha', 'Bilal', { keys: ['SHIMLA'] }, { money: 100 });
    const theirs = offer(g, 'Bilal', 'Asha', { keys: ['AGRA'] }, { keys: ['SHIMLA'] });
    const other = offer(g, 'Bilal', 'Chitra', { keys: ['AGRA'] }, { money: 100 });
    g.act('Asha', { type, propertyKey: 'SHIMLA' });
    const status = (id: string) => g.state.trades.find((x) => x.id === id)!.status;
    expect([status(mine.id), status(theirs.id)]).toEqual(['EXPIRED', 'EXPIRED']);
    // An offer that does not include the changed property is untouched.
    expect(status(other.id)).toBe('PENDING');
    expect(() => g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: mine.id })).toThrow('This offer was already expired.');
  });

  it('undoing a build that an offer was made on closes that offer too', () => {
    const g = new TestGame();
    g.give('Asha', 'SHIMLA');
    g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'SHIMLA' });
    const t = offer(g, 'Asha', 'Bilal', { keys: ['SHIMLA'] }, { money: 100 });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: g.state.undoStack.at(-1)!.actionId });
    g.act(g.state.players.find((p) => g.state.undoRequest!.approverIds.includes(p.id))!.name, { type: 'APPROVE_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.properties.SHIMLA.houses).toBe(0);
    expect(g.state.trades.find((x) => x.id === t.id)!.status).toBe('EXPIRED');
  });

  it('undoing the trade returns the property with the same buildings', () => {
    const g = new TestGame();
    g.give('Asha', 'SHIMLA', { houses: 3 });
    const t = offer(g, 'Asha', 'Bilal', { keys: ['SHIMLA'] }, { money: 2000 });
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: t.id });
    g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: g.state.undoStack.at(-1)!.actionId });
    g.act('Bilal', { type: 'APPROVE_UNDO', requestId: g.state.undoRequest!.id });
    expect(g.state.properties.SHIMLA).toEqual({ key: 'SHIMLA', ownerId: g.id('Asha'), houses: 3, hotel: false, mortgaged: false });
    expect([g.balance('Asha'), g.balance('Bilal')]).toEqual([START, START]);
  });
});
