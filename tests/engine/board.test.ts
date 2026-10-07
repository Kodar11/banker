import { describe, expect, it } from 'vitest';
import {
  ALL_CARDS,
  BOARD_CORNERS,
  BOARD_CYCLE,
  BOARD_LAYOUT,
  BOARD_ROWS,
  BOARD_SIZE,
  deriveBoardCycle,
  PROPERTY_DEEDS,
  PROPERTY_KEYS,
  positionOfProperty,
  positionOfSpecial,
  positionsOfSpecial,
  spaceAt,
  spaceName,
  spaceTypeOf,
  type SquareId,
} from '@/engine/index.ts';
import { TestGame } from './harness.ts';

/** The physical board, exactly as dictated by its owner (names as printed). */
const DICTATED_ROWS = [
  ['Start', 'Mumbai', 'Water Works', 'Railway', 'Ahmedabad', 'Income Tax', 'Indore', 'Chance', 'Jaipur', 'Jail'],
  ['Jail', 'Delhi', 'Chandigarh', 'Electric Company', 'BEST', 'Shimla', 'Amritsar', 'Community Chest', 'Srinagar', 'Club'],
  ['Club', 'Agra', 'Chance', 'Kanpur', 'Patna', 'Darjeeling', 'Air India', 'Calcutta', 'Hyderabad', 'Rest House'],
  ['Rest House', 'Madras', 'Community Chest', 'Bangalore', 'Wealth Taxes', 'Ootacamund', 'Cochin', 'Motor Boat', 'Margao', 'Start'],
];

const EXPECTED_CYCLE = [
  'Start', 'Mumbai', 'Water Works', 'Railway', 'Ahmedabad', 'Income Tax', 'Indore', 'Chance', 'Jaipur', 'Jail',
  'Delhi', 'Chandigarh', 'Electric Company', 'BEST', 'Shimla', 'Amritsar', 'Community Chest', 'Srinagar', 'Club',
  'Agra', 'Chance', 'Kanpur', 'Patna', 'Darjeeling', 'Air India', 'Calcutta', 'Hyderabad', 'Rest House',
  'Madras', 'Community Chest', 'Bangalore', 'Wealth Taxes', 'Ootacamund', 'Cochin', 'Motor Boat', 'Margao',
];

const nameOf = (id: SquareId) => spaceName(BOARD_CYCLE.indexOf(id));

describe('physical board — rows are the source of truth', () => {
  it('BOARD_ROWS spell exactly the dictated rows', () => {
    const rowNames = BOARD_ROWS.map((row) =>
      row.map((id) => (id in PROPERTY_DEEDS ? PROPERTY_DEEDS[id as keyof typeof PROPERTY_DEEDS].name : nameOf(id))),
    );
    expect(rowNames).toEqual(DICTATED_ROWS);
  });

  it('every row is valid: starts on its corner and ends on the next row’s corner', () => {
    BOARD_ROWS.forEach((row, i) => {
      expect(row[0]).toBe(BOARD_CORNERS[i]);
      expect(row[row.length - 1]).toBe(BOARD_CORNERS[(i + 1) % BOARD_CORNERS.length]);
      expect(row.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('derives the unique cycle with shared (never duplicated) corners', () => {
    expect(BOARD_LAYOUT.map((_, i) => spaceName(i))).toEqual(EXPECTED_CYCLE);
    // Count derived from the rows, not hard-coded: Σ(row length − 1).
    const derivedCount = BOARD_ROWS.reduce((n, row) => n + row.length - 1, 0);
    expect(BOARD_SIZE).toBe(derivedCount);
    expect(BOARD_SIZE).toBe(36);
    for (const corner of BOARD_CORNERS) expect(BOARD_CYCLE.filter((id) => id === corner)).toHaveLength(1);
  });

  it('corner references are correct', () => {
    expect(positionOfSpecial('START')).toBe(0);
    expect(positionOfSpecial('JAIL')).toBe(9);
    expect(positionOfSpecial('CLUB')).toBe(18);
    expect(positionOfSpecial('REST_HOUSE')).toBe(27);
  });

  it('has no accidental duplicate non-corner squares (only the card squares repeat)', () => {
    const counts = new Map<SquareId, number>();
    for (const id of BOARD_CYCLE) counts.set(id, (counts.get(id) ?? 0) + 1);
    const repeated = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort();
    expect(repeated).toEqual(['CHANCE', 'COMMUNITY_CHEST']);
    expect(positionsOfSpecial('CHANCE')).toEqual([7, 20]);
    expect(positionsOfSpecial('COMMUNITY_CHEST')).toEqual([16, 29]);
  });

  it('wraps from Margao back to Start', () => {
    expect(spaceName(BOARD_SIZE - 1)).toBe('Margao');
    expect(spaceName(BOARD_SIZE)).toBe('Start');
    expect(spaceAt(BOARD_SIZE)).toEqual(spaceAt(0));
  });

  it('every property with a deed is on the board exactly once, and every board property has a deed', () => {
    const onBoard = BOARD_LAYOUT.flatMap((s) => (s.kind === 'PROPERTY' ? [s.propertyKey] : []));
    expect([...onBoard].sort()).toEqual([...PROPERTY_KEYS].sort());
    expect(new Set(onBoard).size).toBe(onBoard.length);
  });

  it('special spaces have explicit types (Club and Wealth Taxes included)', () => {
    const types = BOARD_LAYOUT.map(spaceTypeOf);
    expect(types[0]).toBe('START');
    expect(types[5]).toBe('TAX');
    expect(types[18]).toBe('CLUB');
    expect(types[31]).toBe('WEALTH_TAX');
    expect(types[27]).toBe('REST_HOUSE');
    expect(types[9]).toBe('JAIL');
    expect(types[3]).toBe('TRANSPORT'); // Railway
    expect(types[2]).toBe('UTILITY'); // Water Works
    expect(types[12]).toBe('UTILITY'); // Electric Company
    expect(types[1]).toBe('PROPERTY'); // Mumbai
  });

  it('names match the physical board spelling', () => {
    expect(PROPERTY_DEEDS.OOTACAMUND.name).toBe('Ootacamund');
    expect(PROPERTY_DEEDS.MARGAO.name).toBe('Margao');
    expect(PROPERTY_DEEDS.SHIMLA.name).toBe('Shimla');
  });

  it('every square a card can move to exists on the board', () => {
    for (const card of ALL_CARDS) {
      for (const e of card.effects) {
        if (e.type === 'MOVE_TO') expect(BOARD_CYCLE).toContain(e.target);
      }
    }
    expect(positionOfProperty('MUMBAI')).toBe(1);
  });
});

describe('board validation rejects broken definitions', () => {
  const rows = BOARD_ROWS.map((r) => [...r]);

  it('mismatched shared corner', () => {
    const bad = rows.map((r) => [...r]);
    bad[0]![bad[0]!.length - 1] = 'CLUB';
    expect(() => deriveBoardCycle(bad)).toThrow(/ends at CLUB/);
  });

  it('board that does not close back to Start', () => {
    const bad = rows.map((r) => [...r]);
    bad[3]![bad[3]!.length - 1] = 'MARGAO';
    expect(() => deriveBoardCycle(bad)).toThrow(/row 1 starts at START/);
  });

  it('duplicated non-corner square', () => {
    const bad = rows.map((r) => [...r]);
    bad[1]![1] = 'MUMBAI';
    expect(() => deriveBoardCycle(bad)).toThrow(/MUMBAI appears more than once/);
  });

  it('unknown square', () => {
    const bad = rows.map((r) => [...r]) as string[][];
    bad[1]![1] = 'NOWHERE';
    expect(() => deriveBoardCycle(bad as SquareId[][])).toThrow(/no title deed/);
  });

  it('corner inside a row', () => {
    const bad = rows.map((r) => [...r]);
    bad[0]![3] = 'JAIL';
    expect(() => deriveBoardCycle(bad)).toThrow(/Corner JAIL appears inside row 1/);
  });
});

describe('movement uses the exact board order', () => {
  it('rolls walk the physical squares in order', () => {
    const g = new TestGame();
    g.roll('Asha', 1, 1);
    expect(spaceName(g.player('Asha').position)).toBe('Water Works');
    g.act('Asha', { type: 'DECLINE_PROPERTY' });
    for (const n of ['Asha', 'Bilal', 'Chitra']) g.act(n, { type: 'PASS_AUCTION', auctionId: g.state.auction!.id });
    g.act('Asha', { type: 'END_TURN' });
    g.placeAt('Bilal', 14);
    g.roll('Bilal', 2, 2);
    expect(spaceName(g.player('Bilal').position)).toBe('Club');
    expect(g.state.turn.phase).toBe('TURN_COMPLETE'); // Club rule NONE (unconfirmed → no effect)
  });
});
