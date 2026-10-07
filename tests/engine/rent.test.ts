import { describe, expect, it } from 'vitest';
import { computeRent, rentMultiplier, sameColorCount, type PropertyKey } from '@/engine/index.ts';
import { TestGame } from './harness.ts';

function rent(g: TestGame, key: PropertyKey, dice = 7) {
  return computeRent(g.state, key, dice);
}

describe('city rent by development level', () => {
  it('Mumbai: site, 1–3 houses, hotel', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    expect(rent(g, 'MUMBAI')).toBe(1200);
    g.give('Asha', 'MUMBAI', { houses: 1 });
    expect(rent(g, 'MUMBAI')).toBe(4000);
    g.give('Asha', 'MUMBAI', { houses: 2 });
    expect(rent(g, 'MUMBAI')).toBe(5500);
    g.give('Asha', 'MUMBAI', { houses: 3 });
    expect(rent(g, 'MUMBAI')).toBe(7500);
    g.give('Asha', 'MUMBAI', { houses: 0, hotel: true });
    expect(rent(g, 'MUMBAI')).toBe(9000);
  });

  it('unowned property has no rent; mortgaged property has no rent', () => {
    const g = new TestGame();
    expect(rent(g, 'DELHI')).toBe(0);
    g.give('Asha', 'DELHI', { mortgaged: true });
    expect(rent(g, 'DELHI')).toBe(0);
  });

  it('owning the whole colour group (5) doubles even unbuilt rent (3+ rule)', () => {
    const g = new TestGame();
    for (const k of ['INDORE', 'AGRA', 'KANPUR', 'PATNA', 'JAIPUR'] as const) g.give('Asha', k);
    expect(rent(g, 'INDORE')).toBe(400);
  });
});

describe('transport / utility paired ownership', () => {
  it('Railway 1000, with BEST 1350', () => {
    const g = new TestGame();
    g.give('Asha', 'RAILWAY');
    expect(rent(g, 'RAILWAY')).toBe(1000);
    g.give('Asha', 'BEST');
    expect(rent(g, 'RAILWAY')).toBe(1350);
  });

  it('BEST 600, with Railway 1350', () => {
    const g = new TestGame();
    g.give('Asha', 'BEST');
    expect(rent(g, 'BEST')).toBe(600);
    g.give('Asha', 'RAILWAY');
    expect(rent(g, 'BEST')).toBe(1350);
  });

  it('pair only counts when the SAME owner has both', () => {
    const g = new TestGame();
    g.give('Asha', 'RAILWAY');
    g.give('Bilal', 'BEST');
    expect(rent(g, 'RAILWAY')).toBe(1000);
    expect(rent(g, 'BEST')).toBe(600);
  });

  it('Air India 1200, with Water Works 1350', () => {
    const g = new TestGame();
    g.give('Asha', 'AIR_INDIA');
    expect(rent(g, 'AIR_INDIA')).toBe(1200);
    g.give('Asha', 'WATER_WORKS');
    expect(rent(g, 'AIR_INDIA')).toBe(1350);
  });

  it('Water Works 500, with Air India 1000', () => {
    const g = new TestGame();
    g.give('Asha', 'WATER_WORKS');
    expect(rent(g, 'WATER_WORKS')).toBe(500);
    g.give('Asha', 'AIR_INDIA');
    expect(rent(g, 'WATER_WORKS')).toBe(1000);
  });

  it('Motor Boat 100 × dice, with Electric Company 200 × dice', () => {
    const g = new TestGame();
    g.give('Asha', 'MOTOR_BOAT');
    expect(rent(g, 'MOTOR_BOAT', 7)).toBe(700);
    expect(rent(g, 'MOTOR_BOAT', 12)).toBe(1200);
    g.give('Asha', 'ELECTRIC_COMPANY');
    expect(rent(g, 'MOTOR_BOAT', 7)).toBe(1400);
  });

  it('Electric Company 50 × dice, with Motor Boat 100 × dice', () => {
    const g = new TestGame();
    g.give('Asha', 'ELECTRIC_COMPANY');
    expect(rent(g, 'ELECTRIC_COMPANY', 8)).toBe(400);
    g.give('Asha', 'MOTOR_BOAT');
    expect(rent(g, 'ELECTRIC_COMPANY', 8)).toBe(800);
  });

  it('a mortgaged partner still counts for the pair (MVP assumption)', () => {
    const g = new TestGame();
    g.give('Asha', 'RAILWAY');
    g.give('Asha', 'BEST', { mortgaged: true });
    expect(rent(g, 'RAILWAY')).toBe(1350);
  });
});

describe('3+ same colour doubles the CURRENT rent', () => {
  const BLUE = ['MUMBAI', 'AHMEDABAD', 'CALCUTTA', 'HYDERABAD', 'DARJEELING'] as const;

  it('0 / 1 / 2 properties of the colour: normal rent', () => {
    const g = new TestGame();
    expect(sameColorCount(g.state, g.id('Asha'), 'BLUE')).toBe(0);
    g.give('Asha', 'MUMBAI');
    expect(sameColorCount(g.state, g.id('Asha'), 'BLUE')).toBe(1);
    expect(rent(g, 'MUMBAI')).toBe(1200);
    g.give('Asha', 'AHMEDABAD');
    expect(rent(g, 'MUMBAI')).toBe(1200);
    expect(rentMultiplier(g.state, 'MUMBAI')).toBe(1);
  });

  it('exactly 3: ×2 on every property of that colour', () => {
    const g = new TestGame();
    for (const k of BLUE.slice(0, 3)) g.give('Asha', k);
    expect(rent(g, 'MUMBAI')).toBe(2400);
    expect(rent(g, 'AHMEDABAD')).toBe(800);
    expect(rent(g, 'CALCUTTA')).toBe(1600);
  });

  it('4 or 5: still ×2 (not ×4)', () => {
    const g = new TestGame();
    for (const k of BLUE.slice(0, 4)) g.give('Asha', k);
    expect(rent(g, 'MUMBAI')).toBe(2400);
    g.give('Asha', 'DARJEELING');
    expect(rent(g, 'MUMBAI')).toBe(2400);
  });

  it('doubling applies AFTER development: houses and hotel', () => {
    const g = new TestGame();
    for (const k of BLUE.slice(0, 3)) g.give('Asha', k);
    g.give('Asha', 'MUMBAI', { houses: 1 });
    expect(rent(g, 'MUMBAI')).toBe(4000 * 2);
    g.give('Asha', 'MUMBAI', { houses: 3 });
    expect(rent(g, 'MUMBAI')).toBe(7500 * 2);
    g.give('Asha', 'MUMBAI', { houses: 0, hotel: true });
    expect(rent(g, 'MUMBAI')).toBe(9000 * 2);
    // Prompt example: developed rent ₹1,500 → ₹3,000 (Ahmedabad with 1 house).
    g.give('Asha', 'AHMEDABAD', { houses: 1 });
    expect(rent(g, 'AHMEDABAD')).toBe(3000);
  });

  it('a mortgaged property charges no rent, but still counts towards the set (configured)', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI', { mortgaged: true });
    g.give('Asha', 'AHMEDABAD');
    g.give('Asha', 'CALCUTTA');
    expect(rent(g, 'MUMBAI')).toBe(0);
    expect(rent(g, 'AHMEDABAD')).toBe(800);
  });

  it('different colour groups never combine', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'AHMEDABAD');
    g.give('Asha', 'INDORE');
    g.give('Asha', 'AGRA');
    expect(rent(g, 'MUMBAI')).toBe(1200);
    expect(rent(g, 'INDORE')).toBe(200);
  });

  it('3 of a colour split between owners: no doubling', () => {
    const g = new TestGame();
    g.give('Asha', 'MUMBAI');
    g.give('Asha', 'AHMEDABAD');
    g.give('Bilal', 'CALCUTTA');
    expect(rent(g, 'MUMBAI')).toBe(1200);
  });

  it('transport / utility have no colour group: owning many never doubles them', () => {
    const g = new TestGame();
    for (const k of ['RAILWAY', 'AIR_INDIA', 'MOTOR_BOAT', 'BEST', 'WATER_WORKS', 'ELECTRIC_COMPANY'] as const) g.give('Asha', k);
    expect(rent(g, 'RAILWAY')).toBe(1350);
    expect(rent(g, 'AIR_INDIA')).toBe(1350);
    expect(rent(g, 'MOTOR_BOAT', 7)).toBe(1400);
    expect(rentMultiplier(g.state, 'RAILWAY')).toBe(1);
  });

  it('the engine charges the doubled rent on landing', () => {
    const g = new TestGame();
    for (const k of ['DELHI', 'CHANDIGARH', 'COCHIN'] as const) g.give('Bilal', k);
    g.give('Bilal', 'DELHI', { houses: 2 });
    g.placeBefore('Asha', 'DELHI', 4);
    g.roll('Asha', 2, 2);
    expect(g.state.turn.pending).toMatchObject({ reason: 'RENT', amount: 4300 * 2, toPlayerId: g.id('Bilal') });
  });
});
