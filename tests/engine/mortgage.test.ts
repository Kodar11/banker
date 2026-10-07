import { describe, expect, it } from 'vitest';
import { BUSINESS_MVP_RULES, computeRent, mortgageResolution, netWorth, unmortgageCost } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

const START = BUSINESS_MVP_RULES.startingCash;
// Mumbai deed: mortgage 4,250; house cost 7,500; hotel cost 7,500; sell-back 50% → 3,750 each.

describe('mortgage — buildings are handed back to the bank and paid for (configured rule)', () => {
  it('without buildings: pays the deed mortgage value', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    const r = g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([['MORTGAGE', 4250]]);
    expect(g.balance('Asha')).toBe(START + 4250);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 0, hotel: false, ownerId: g.id('Asha') });
  });

  it('with houses: mortgage value + sell-back value of each house; houses removed', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    expect(mortgageResolution(g.state.properties.MUMBAI)).toEqual({
      mortgageValue: 4250,
      buildingValue: 7500,
      payout: 11750,
      housesReturned: 2,
      hotelReturned: false,
    });
    const r = g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(r.transactions.map((t) => [t.type, t.amount])).toEqual([
      ['HOUSE_SALE', 7500],
      ['MORTGAGE', 4250],
    ]);
    expect(g.balance('Asha')).toBe(START + 11750);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 0, hotel: false });
  });

  it('with a hotel: hotel + the 3 houses it replaced, at sell-back value', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { hotel: true });
    const m = mortgageResolution(g.state.properties.MUMBAI);
    expect(m).toMatchObject({ buildingValue: 3750 + 3 * 3750, payout: 4250 + 15000, hotelReturned: true });
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(g.balance('Asha')).toBe(START + 19250);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: true, houses: 0, hotel: false });
    // Same total as selling hotel → houses one at a time and then mortgaging.
    const h = new TestGame();
    h.give('Asha', 'MUMBAI', { hotel: true });
    for (let i = 0; i < 4; i += 1) h.act('Asha', { type: 'SELL_BUILDING', propertyKey: 'MUMBAI' });
    h.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(h.balance('Asha')).toBe(g.balance('Asha'));
  });

  it('rent after mortgage is zero; landing charges nothing', () => {
    const g = new TestGame();
    g.give('Bilal', 'DELHI', { houses: 1 });
    g.act('Bilal', { type: 'MORTGAGE_PROPERTY', propertyKey: 'DELHI' });
    expect(computeRent(g.state, 'DELHI', 7)).toBe(0);
    g.placeBefore('Asha', 'DELHI', 4);
    g.roll('Asha', 2, 2);
    expect(g.state.turn.phase).toBe('TURN_COMPLETE');
  });

  it('net worth reflects the mortgage (cash in, deed minus mortgage value, no buildings)', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 2 });
    const before = netWorth(g.state, g.id('Asha'));
    expect(before).toBe(START + 8500 + 2 * 7500);
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(netWorth(g.state, g.id('Asha'))).toBe(START + 11750 + (8500 - 4250));
  });

  it('unmortgage costs value + 10% and does not bring buildings back', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { houses: 1 });
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(() => g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'MUMBAI' })).toThrow('Already mortgaged.');
    g.act('Asha', { type: 'UNMORTGAGE_PROPERTY', propertyKey: 'MUMBAI' });
    expect(unmortgageCost('MUMBAI')).toBe(4675);
    expect(g.state.properties.MUMBAI).toMatchObject({ mortgaged: false, houses: 0 });
    expect(computeRent(g.state, 'MUMBAI', 7)).toBe(1200);
  });

  it('cannot build on a mortgaged site; can mortgage transport', () => {
    const g = new TestGame();
    g.give('Asha', 'INDORE', { mortgaged: true });
    expect(() => g.act('Asha', { type: 'BUILD_HOUSE', propertyKey: 'INDORE' })).toThrow('Unmortgage this property first.');
    g.give('Asha', 'RAILWAY');
    g.act('Asha', { type: 'MORTGAGE_PROPERTY', propertyKey: 'RAILWAY' });
    expect(g.balance('Asha')).toBe(START + 4750);
  });
});
