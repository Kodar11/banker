import { describe, expect, it } from 'vitest';
import { computeRent, type PropertyKey } from '@/engine/index.ts';
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

  it('no full-group bonus on unbuilt sites', () => {
    const g = new TestGame();
    for (const k of ['INDORE', 'AGRA', 'KANPUR', 'PATNA', 'JAIPUR'] as const) g.give('Asha', k);
    expect(rent(g, 'INDORE')).toBe(200);
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
