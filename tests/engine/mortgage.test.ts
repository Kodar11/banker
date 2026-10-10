import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BUSINESS_MVP_RULES,
  computeRent,
  getDeed,
  mortgagePayout,
  netWorth,
  PROPERTY_KEYS,
  unmortgageCost,
  wealthTaxDue,
  type PropertyState,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;
// Mumbai deed: price 8,500; mortgage 4,250; house 7,500; hotel 7,500. Unmortgage = 4,250 + 10% = 4,675.

type Built = Pick<PropertyState, 'houses' | 'hotel'>;
const DEVELOPMENT: [string, Built][] = [
  ['an undeveloped property', { houses: 0, hotel: false }],
  ['a property with one house', { houses: 1, hotel: false }],
  ['a property with two houses', { houses: 2, hotel: false }],
  ['a property with three houses', { houses: 3, hotel: false }],
  ['a property with a hotel', { houses: 0, hotel: true }],
];

function undoTop(g: TestGame, requester: string) {
  const target = g.state.undoStack.at(-1)!;
  g.act(requester, { type: 'REQUEST_UNDO', targetActionId: target.actionId });
  const req = g.state.undoRequest!;
  return g.act(g.state.players.find((p) => req.approverIds.includes(p.id))!.name, { type: 'APPROVE_UNDO', requestId: req.id });
}

describe('mortgage — pays the printed mortgage value; ownership and buildings are kept', () => {
  it.each(DEVELOPMENT)('%s: one MORTGAGE transaction for the deed value, nothing for buildings, nothing removed', (_label, built) => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', built);
    const r = g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => [t.type, t.amount, t.fromPlayerId, t.toPlayerId])).toEqual([['MORTGAGE', 4250, null, g.id('Asha')]]);
    expect(g.balance('Asha')).toBe(START + 4250);
    expect(g.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: g.id('Asha'), mortgaged: true, ...built });
    // No building sale of any kind was posted.
    expect(g.ledger.some((t) => t.type === 'HOUSE_SALE' || t.type === 'HOTEL_SALE')).toBe(false);
  });

  it('the payout is the deed mortgage value for every property, developed or not', () => {
    for (const key of PROPERTY_KEYS) {
      expect(mortgagePayout(key)).toBe(getDeed(key).mortgageValue);
      const g = new TestGame();
      g.give('Asha', key, getDeed(key).kind === 'CITY' ? { hotel: true } : {});
      g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: key });
      expect(g.balance('Asha')).toBe(START + getDeed(key).mortgageValue);
    }
  });

  it('the log says what was paid and that the buildings stay', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    const r = g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(r.events.find((e) => e.type === 'PROPERTY_MORTGAGED')).toMatchObject({
      message: 'Asha mortgaged Mumbai for ₹4,250 (2 houses stay, inactive)',
      payload: { payout: 4250, mortgageValue: 4250, houses: 2, hotel: false },
    });
  });
});

describe('a mortgaged property and its buildings are inactive', () => {
  it.each(DEVELOPMENT)('%s earns no rent while mortgaged; landing on it charges nothing', (_label, built) => {
    const g = new TestGame();
    g.give('Bilal', 'DELHI', built);
    g.act('Bilal', { type: 'MORTGAGE_PROPERTY', propertyKey: 'DELHI' });
    expect(computeRent(g.state, 'DELHI', 7)).toBe(0);
    g.placeBefore('Asha', 'DELHI', 4);
    const r = g.roll('Asha', 2, 2);
    expect(r.transactions).toEqual([]);
    expect(g.state.turn).toMatchObject({ phase: 'TURN_COMPLETE', pending: null });
    expect(g.balance('Asha')).toBe(START);
  });

  it('no building, no selling of buildings and no sale to the bank while mortgaged — nothing changes', () => {
    const g = new TestGame();
    g.giveGroup('Asha', 'MUMBAI', { houses: 2, mortgaged: true });
    const before = structuredClone(g.state.properties.MUMBAI);
    for (const type of ['BUILD_HOUSE', 'BUILD_HOTEL', 'SELL_BUILDING'] as const) {
      expect(() => g.act('Asha', { type, propertyKey: 'MUMBAI' })).toThrow('Unmortgage this property first.');
    }
    expect(() => g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'MUMBAI' })).toThrow('Sell the buildings first.');
    g.give('Asha', 'MUMBAI', { houses: 3, mortgaged: true });
    expect(() => g.act('Asha', { type: 'BUILD_HOTEL', propertyKey: 'MUMBAI' })).toThrow('Unmortgage this property first.');
    g.give('Asha', 'MUMBAI', { houses: 0, hotel: true, mortgaged: true });
    expect(() => g.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' })).toThrow('Unmortgage this property first.');
    g.give('Asha', 'MUMBAI', before);
    expect(g.balance('Asha')).toBe(START);
    expect(g.ledger.filter((t) => t.type !== 'STARTING_FUNDS')).toEqual([]);
  });

  it('a mortgaged, undeveloped property cannot be sold to the bank either', () => {
    const g = new TestGame();
    g.give('Asha', 'RAILWAY', { mortgaged: true });
    expect(() => g.act('Asha', { type: 'SELL_PROPERTY', propertyKey: 'RAILWAY' })).toThrow('Unmortgage before selling.');
  });

  it('its buildings still count for Wealth Taxes, and it still counts towards the colour set', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2, mortgaged: true });
    g.give('Asha', 'CALCUTTA', { hotel: true, mortgaged: true });
    expect(wealthTaxDue(g.state, g.id('Asha'))).toEqual({ houses: 2, hotels: 1, amount: 400 });
    g.give('Asha', 'AHMEDABAD');
    // Ahmedabad (site rent 400) is the third blue property: doubled, though the other two are mortgaged.
    expect(computeRent(g.state, 'AHMEDABAD', 7)).toBe(800);
  });

  it('a mortgaged property can be traded, with or without buildings: mortgage and buildings go to the new owner', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 1, mortgaged: true });
    g.give('Asha', 'DELHI', { mortgaged: true });
    const trade = (key: 'MUMBAI' | 'DELHI') =>
      g.act('Asha', { type: 'CREATE_TRADE', toPlayerId: g.id('Bilal'), offeredPropertyKeys: [key], requestedPropertyKeys: [], offeredMoney: 0, requestedMoney: 100 });
    trade('MUMBAI');
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: g.state.trades.at(-1)!.id });
    expect(g.state.properties.MUMBAI).toMatchObject({ ownerId: g.id('Bilal'), mortgaged: true, houses: 1 });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: 100 });
    trade('DELHI');
    g.act('Bilal', { type: 'ACCEPT_TRADE', tradeId: g.state.trades.at(-1)!.id });
    expect(g.state.properties.DELHI).toMatchObject({ ownerId: g.id('Bilal'), mortgaged: true });
    // The new owner pays the same mortgage value + 10% to unmortgage.
    g.act('Bilal', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'DELHI' });
    expect(g.balance('Bilal')).toBe(START - 100 - unmortgageCost('DELHI'));
  });
});

describe('unmortgage — mortgage value + 10%; the buildings are active again as they were', () => {
  it('the cost is the deed mortgage value plus 10% for every property', () => {
    for (const key of PROPERTY_KEYS) {
      const value = getDeed(key).mortgageValue;
      expect(unmortgageCost(key)).toBe(value + Math.round(value * BUSINESS_MVP_RULES.mortgage.unmortgageInterestRate));
    }
    expect(unmortgageCost('MUMBAI')).toBe(4675);
  });

  it.each(DEVELOPMENT)('%s: pays 4,675, clears the mortgage, same buildings, rent as before the mortgage', (_label, built) => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', built);
    const rentBefore = computeRent(g.state, 'MUMBAI', 7);
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    const r = g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => [t.type, t.amount, t.fromPlayerId, t.toPlayerId])).toEqual([['UNMORTGAGE', 4675, g.id('Asha'), null]]);
    expect(g.balance('Asha')).toBe(START + 4250 - 4675);
    expect(g.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: g.id('Asha'), mortgaged: false, ...built });
    expect(computeRent(g.state, 'MUMBAI', 7)).toBe(rentBefore);
    // Nothing was bought again.
    expect(g.ledger.some((t) => t.type === 'HOUSE_PURCHASE' || t.type === 'HOTEL_PURCHASE')).toBe(false);
  });

  it('the worked example: two houses, mortgage → no rent → unmortgage → both houses earn rent again', () => {
    const g = new TestGame();
    g.give('Bilal', 'MUMBAI', { houses: 2 });
    g.act('Bilal', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    g.placeBefore('Asha', 'MUMBAI', 4);
    g.roll('Asha', 2, 2);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
    g.act('Bilal', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: false, houses: 2 });
    expect(computeRent(g.state, 'MUMBAI', 7)).toBe(5500);
  });

  it('is rejected when the player cannot pay: the mortgage stays and nothing is charged', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2, mortgaged: true });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Bilal'), amount: START - 4674 });
    const before = structuredClone(g.state);
    expect(() => g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow('Not enough money to unmortgage.');
    expect(g.state).toEqual(before);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 2 });
    // One rupee more is enough.
    g.act('Bilal', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Asha'), amount: 1 });
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(g.balance('Asha')).toBe(0);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: false, houses: 2 });
  });

  it("only the owner can mortgage or unmortgage; a property that is not mortgaged can't be unmortgaged", () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    expect(() => g.act('Bilal', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow("You don't own this property.");
    expect(() => g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow('Not mortgaged.');
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(() => g.act('Bilal', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow("You don't own this property.");
  });
});

describe('mortgage — repeated, competing and undone requests', () => {
  it('a second mortgage (double tap, retry) is refused and pays nothing', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 3 });
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(() => g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow('Already mortgaged.');
    expect(g.ledger.filter((t) => t.type === 'MORTGAGE')).toHaveLength(1);
    expect(g.balance('Asha')).toBe(START + 4250);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 3 });
  });

  it('a second unmortgage is refused and charges nothing', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { hotel: true, mortgaged: true });
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(() => g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow('Not mortgaged.');
    expect(g.ledger.filter((t) => t.type === 'UNMORTGAGE')).toHaveLength(1);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: false, hotel: true, houses: 0 });
  });

  it('two requests computed from the same state: applying one makes the other fail on the new state', () => {
    // The server applies actions one at a time on the locked game row; the loser of a race is
    // re-validated against the winner's result. Either order ends in one mortgage, buildings intact.
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    const base = g.state;
    const mortgage = { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' } as const;
    const first = applyAction(base, g.id('Asha'), mortgage, g.ctx());
    expect(first.state.version).toBe(base.version + 1);
    expect(() => applyAction(first.state, g.id('Asha'), mortgage, g.ctx())).toThrow('Already mortgaged.');
    // A failed action never touched the state it was given.
    expect(base.properties.MUMBAI).toMatchObject({ mortgaged: false, houses: 2 });
    expect(first.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 2 });
    // Mortgage racing a building sale: whichever lands second sees the other's result.
    const sold = applyAction(base, g.id('Asha'), { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' }, g.ctx());
    const then = applyAction(sold.state, g.id('Asha'), mortgage, g.ctx());
    expect(then.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 1 });
    expect(() => applyAction(first.state, g.id('Asha'), { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' }, g.ctx())).toThrow('Unmortgage this property first.');
  });

  it.each(DEVELOPMENT)('undo of a mortgage on %s: mortgage cleared, payout returned, buildings exactly as before', (_label, built) => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', built);
    const before = structuredClone(g.state.properties.MUMBAI);
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    const r = undoTop(g, 'Asha');
    expect(r.transactions).toMatchObject([{ type: 'UNDO_REVERSAL', fromPlayerId: g.id('Asha'), toPlayerId: null, amount: 4250 }]);
    expect(g.state.properties.MUMBAI).toEqual(before);
    expect(g.balance('Asha')).toBe(START);
  });

  it('undo of an unmortgage: mortgaged again, cost refunded, buildings exactly as before', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 3, mortgaged: true });
    const before = structuredClone(g.state.properties.MUMBAI);
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    undoTop(g, 'Asha');
    expect(g.state.properties.MUMBAI).toEqual(before);
    expect(g.balance('Asha')).toBe(START);
  });

  it('a mortgage cannot be undone once the property has changed again', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 1 });
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    const mortgageAction = g.state.undoStack.at(-1)!.actionId;
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(() => g.act('Asha', { type: 'REQUEST_UNDO', targetActionId: mortgageAction })).toThrow('Undo newer actions first.');
  });
});

describe('mortgage — net worth and bankruptcy stay consistent', () => {
  it('net worth: the payout arrives as cash, the deed loses its mortgage value, the buildings keep their value', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    const before = netWorth(g.state, g.id('Asha'));
    expect(before).toBe(START + 8500 + 2 * 7500);
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    // +4,250 cash, −4,250 deed: mortgaging by itself does not change net worth.
    expect(netWorth(g.state, g.id('Asha'))).toBe(before);
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    // Only the 10% interest was lost.
    expect(netWorth(g.state, g.id('Asha'))).toBe(before - 425);
  });

  it('bankruptcy returns a mortgaged, developed property to the bank clean: no owner, no buildings, no mortgage', () => {
    const g = new TestGame();
    g.give('Bilal', 'DELHI', { hotel: true });
    g.give('Asha', 'MUMBAI', { houses: 2, mortgaged: true });
    g.act('Asha', { type: 'TRANSFER_MONEY', toPlayerId: g.id('Chitra'), amount: START - 100 });
    g.placeBefore('Asha', 'DELHI', 4);
    g.roll('Asha', 2, 2);
    g.act('Asha', { type: 'DECLARE_BANKRUPTCY' });
    expect(g.state.properties.MUMBAI).toEqual({ key: 'MUMBAI', ownerId: null, houses: 0, hotel: false, mortgaged: false });
  });
});
