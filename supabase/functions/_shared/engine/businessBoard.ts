/**
 * BUSINESS — static board data. THE single source of truth for the board.
 *
 * 1. PROPERTY_DEEDS — AUTHORITATIVE. Transcribed from photographs of the
 *    physical title-deed cards. Do not "normalise" or adjust these values.
 *
 * 2. BOARD_ROWS — AUTHORITATIVE. The four sides of the physical board exactly as
 *    dictated by the owner of the board, corner to corner. Corners are shared
 *    between adjacent rows; the cyclic BOARD_LAYOUT is DERIVED from the rows and
 *    validated at module load (deriveBoardCycle throws on any inconsistency).
 *
 * The database catalog (supabase/migrations/*_catalog.sql) is generated from this
 * file by scripts/print-catalog-sql.ts and a test keeps them in sync.
 * Runtime state (owner, houses, hotel, mortgage) lives in the database, never here.
 */

/**
 * V2 = the physical board order + confirmed card tables. V1 games used a
 * placeholder board order and are not loadable by this engine.
 */
export const RULES_VERSION = 'BUSINESS_V2' as const;

export type ColorGroup = 'BLUE' | 'PURPLE' | 'GREEN' | 'PINK';
export type PropertyGroup = ColorGroup | 'TRANSPORT_UTILITY';

export type PropertyKey =
  // Blue
  | 'MUMBAI'
  | 'AHMEDABAD'
  | 'CALCUTTA'
  | 'HYDERABAD'
  | 'DARJEELING'
  // Purple
  | 'SHIMLA'
  | 'MADRAS'
  | 'AMRITSAR'
  | 'SRINAGAR'
  | 'BANGALORE'
  // Green
  | 'INDORE'
  | 'AGRA'
  | 'KANPUR'
  | 'PATNA'
  | 'JAIPUR'
  // Pink
  | 'DELHI'
  | 'CHANDIGARH'
  | 'COCHIN'
  | 'OOTACAMUND'
  | 'MARGAO'
  // Transport / utility
  | 'RAILWAY'
  | 'AIR_INDIA'
  | 'MOTOR_BOAT'
  | 'BEST'
  | 'ELECTRIC_COMPANY'
  | 'WATER_WORKS';

export interface CityDeed {
  kind: 'CITY';
  key: PropertyKey;
  name: string;
  group: ColorGroup;
  price: number;
  /** [site only, 1 house, 2 houses, 3 houses] */
  rent: readonly [number, number, number, number];
  hotelRent: number;
  houseCost: number;
  hotelCost: number;
  mortgageValue: number;
}

export type TransportRent =
  | {
      type: 'FIXED';
      base: number;
      /** Owning this partner too raises the rent to pairedRent. */
      pairedWith: PropertyKey;
      pairedRent: number;
    }
  | {
      type: 'DICE_MULTIPLIER';
      /** Rent = multiplier × number shown on dice. */
      multiplier: number;
      pairedWith: PropertyKey;
      pairedMultiplier: number;
    };

export interface TransportDeed {
  kind: 'TRANSPORT_UTILITY';
  key: PropertyKey;
  name: string;
  group: 'TRANSPORT_UTILITY';
  /** Board square type. Not a colour group: never counts towards colour-set rent doubling. */
  category: 'TRANSPORT' | 'UTILITY';
  price: number;
  rent: TransportRent;
  mortgageValue: number;
}

export type PropertyDeed = CityDeed | TransportDeed;

function city(
  key: PropertyKey,
  name: string,
  group: ColorGroup,
  price: number,
  rent: [number, number, number, number],
  hotelRent: number,
  houseCost: number,
  hotelCost: number,
  mortgageValue: number,
): CityDeed {
  return { kind: 'CITY', key, name, group, price, rent, hotelRent, houseCost, hotelCost, mortgageValue };
}

/** AUTHORITATIVE — from the photographed title deeds. */
export const PROPERTY_DEEDS: Readonly<Record<PropertyKey, PropertyDeed>> = {
  // ---------------- BLUE ----------------
  MUMBAI: city('MUMBAI', 'Mumbai', 'BLUE', 8500, [1200, 4000, 5500, 7500], 9000, 7500, 7500, 4250),
  AHMEDABAD: city('AHMEDABAD', 'Ahmedabad', 'BLUE', 4000, [400, 1500, 3000, 4200], 5000, 4500, 4500, 2000),
  CALCUTTA: city('CALCUTTA', 'Calcutta', 'BLUE', 6500, [800, 3200, 4500, 6500], 8000, 6000, 6000, 3250),
  HYDERABAD: city('HYDERABAD', 'Hyderabad', 'BLUE', 3500, [300, 1200, 3000, 4500], 6000, 5000, 5000, 1750),
  DARJEELING: city('DARJEELING', 'Darjeeling', 'BLUE', 2500, [200, 1200, 2600, 3500], 5000, 3000, 3000, 1250),

  // ---------------- PURPLE ----------------
  SHIMLA: city('SHIMLA', 'Shimla', 'PURPLE', 2200, [200, 1000, 2750, 4500], 6000, 3500, 3500, 1100),
  MADRAS: city('MADRAS', 'Madras', 'PURPLE', 7000, [900, 3500, 5000, 7000], 8500, 6500, 6500, 3500),
  AMRITSAR: city('AMRITSAR', 'Amritsar', 'PURPLE', 3300, [300, 1400, 2800, 4000], 5000, 4500, 4500, 1050),
  SRINAGAR: city('SRINAGAR', 'Srinagar', 'PURPLE', 5000, [550, 3500, 5000, 7000], 8000, 6000, 6000, 2500),
  BANGALORE: city('BANGALORE', 'Bangalore', 'PURPLE', 4000, [400, 1500, 3000, 4500], 5500, 4500, 4500, 2000),

  // ---------------- GREEN ----------------
  INDORE: city('INDORE', 'Indore', 'GREEN', 1500, [200, 600, 1500, 2500], 3600, 2000, 2000, 750),
  AGRA: city('AGRA', 'Agra', 'GREEN', 2500, [200, 900, 1600, 2500], 3500, 3000, 3000, 1250),
  KANPUR: city('KANPUR', 'Kanpur', 'GREEN', 4000, [400, 1500, 3000, 4500], 5500, 4500, 4500, 2000),
  PATNA: city('PATNA', 'Patna', 'GREEN', 2000, [150, 800, 2000, 3000], 4500, 2500, 2500, 1000),
  JAIPUR: city('JAIPUR', 'Jaipur', 'GREEN', 3000, [250, 1500, 2700, 4000], 5500, 4000, 4000, 1500),

  // ---------------- PINK ----------------
  DELHI: city('DELHI', 'Delhi', 'PINK', 6000, [750, 3000, 4300, 5500], 7500, 5000, 5000, 4000),
  CHANDIGARH: city('CHANDIGARH', 'Chandigarh', 'PINK', 2500, [200, 900, 1600, 2500], 3500, 3000, 3000, 1250),
  COCHIN: city('COCHIN', 'Cochin', 'PINK', 3000, [300, 1200, 2000, 4250], 5500, 4000, 4000, 1500),
  OOTACAMUND: city('OOTACAMUND', 'Ootacamund', 'PINK', 2500, [200, 1000, 2250, 3500], 4500, 3000, 3000, 1250),
  MARGAO: city('MARGAO', 'Margao', 'PINK', 4000, [400, 2200, 3500, 5000], 6500, 4500, 4500, 2000),

  // ---------------- TRANSPORT / UTILITY ----------------
  RAILWAY: {
    kind: 'TRANSPORT_UTILITY',
    key: 'RAILWAY',
    category: 'TRANSPORT',
    name: 'Railway',
    group: 'TRANSPORT_UTILITY',
    price: 9500,
    rent: { type: 'FIXED', base: 1000, pairedWith: 'BEST', pairedRent: 1350 },
    mortgageValue: 4750,
  },
  AIR_INDIA: {
    kind: 'TRANSPORT_UTILITY',
    key: 'AIR_INDIA',
    category: 'TRANSPORT',
    name: 'Air India',
    group: 'TRANSPORT_UTILITY',
    price: 10500,
    rent: { type: 'FIXED', base: 1200, pairedWith: 'WATER_WORKS', pairedRent: 1350 },
    mortgageValue: 4750,
  },
  MOTOR_BOAT: {
    kind: 'TRANSPORT_UTILITY',
    key: 'MOTOR_BOAT',
    category: 'TRANSPORT',
    name: 'Motor Boat',
    group: 'TRANSPORT_UTILITY',
    price: 5500,
    rent: { type: 'DICE_MULTIPLIER', multiplier: 100, pairedWith: 'ELECTRIC_COMPANY', pairedMultiplier: 200 },
    mortgageValue: 1750,
  },
  BEST: {
    kind: 'TRANSPORT_UTILITY',
    key: 'BEST',
    category: 'TRANSPORT',
    name: 'BEST',
    group: 'TRANSPORT_UTILITY',
    price: 3500,
    rent: { type: 'FIXED', base: 600, pairedWith: 'RAILWAY', pairedRent: 1350 },
    mortgageValue: 1750,
  },
  ELECTRIC_COMPANY: {
    kind: 'TRANSPORT_UTILITY',
    key: 'ELECTRIC_COMPANY',
    category: 'UTILITY',
    name: 'Electric Company',
    group: 'TRANSPORT_UTILITY',
    price: 2500,
    rent: { type: 'DICE_MULTIPLIER', multiplier: 50, pairedWith: 'MOTOR_BOAT', pairedMultiplier: 100 },
    mortgageValue: 1750,
  },
  WATER_WORKS: {
    kind: 'TRANSPORT_UTILITY',
    key: 'WATER_WORKS',
    category: 'UTILITY',
    name: 'Water Works',
    group: 'TRANSPORT_UTILITY',
    price: 3200,
    rent: { type: 'FIXED', base: 500, pairedWith: 'AIR_INDIA', pairedRent: 1000 },
    mortgageValue: 1600,
  },
};

export const PROPERTY_KEYS = Object.keys(PROPERTY_DEEDS) as PropertyKey[];

export const GROUP_LABELS: Record<PropertyGroup, string> = {
  BLUE: 'Blue',
  PURPLE: 'Purple',
  GREEN: 'Green',
  PINK: 'Pink',
  TRANSPORT_UTILITY: 'Transport & Utility',
};

export function getDeed(key: PropertyKey): PropertyDeed {
  return PROPERTY_DEEDS[key];
}

export function isPropertyKey(value: string): value is PropertyKey {
  return Object.prototype.hasOwnProperty.call(PROPERTY_DEEDS, value);
}

export function groupMembers(group: PropertyGroup): PropertyKey[] {
  return PROPERTY_KEYS.filter((k) => PROPERTY_DEEDS[k].group === group);
}

// ---------------------------------------------------------------------------
// Board squares
// ---------------------------------------------------------------------------

/** Every non-property square on the physical board. */
export type SpecialSpaceType =
  | 'START'
  | 'JAIL'
  | 'CLUB'
  | 'REST_HOUSE'
  | 'INCOME_TAX'
  | 'WEALTH_TAX'
  | 'CHANCE'
  | 'COMMUNITY_CHEST';

/** One token in BOARD_ROWS: a property key or a special square. */
export type SquareId = PropertyKey | SpecialSpaceType;

/**
 * Domain-level square type. City sites are PROPERTY; transport/utility deeds are
 * split by their board category; Wealth Taxes is its own type (charged on
 * buildings, unlike Income Tax which is charged on properties — see
 * BUSINESS_MVP_RULES.incomeTax / wealthTax).
 */
export type SpaceType =
  | 'PROPERTY'
  | 'TRANSPORT'
  | 'UTILITY'
  | 'CHANCE'
  | 'COMMUNITY_CHEST'
  | 'TAX'
  | 'WEALTH_TAX'
  | 'START'
  | 'JAIL'
  | 'CLUB'
  | 'REST_HOUSE';

export type BoardSpace =
  | { kind: 'PROPERTY'; propertyKey: PropertyKey }
  | { kind: 'SPECIAL'; type: SpecialSpaceType; label: string };

export const SPECIAL_LABELS: Record<SpecialSpaceType, string> = {
  START: 'Start',
  JAIL: 'Jail',
  CLUB: 'Club',
  REST_HOUSE: 'Rest House',
  INCOME_TAX: 'Income Tax',
  WEALTH_TAX: 'Wealth Taxes',
  CHANCE: 'Chance',
  COMMUNITY_CHEST: 'Community Chest',
};

/** The four corners, in board order. Each is shared by two adjacent rows. */
export const BOARD_CORNERS = ['START', 'JAIL', 'CLUB', 'REST_HOUSE'] as const satisfies readonly SpecialSpaceType[];

/** Squares that legitimately appear more than once around the board (card squares). */
const REPEATABLE_SQUARES: ReadonlySet<SquareId> = new Set<SquareId>(['CHANCE', 'COMMUNITY_CHEST']);

/**
 * AUTHORITATIVE — the physical board, side by side, exactly as dictated.
 * Each row runs corner → corner in the direction of play; the last square of a
 * row is the first square of the next, and row 4 ends back at Start.
 */
export const BOARD_ROWS: readonly (readonly SquareId[])[] = [
  // Row 1
  ['START', 'MUMBAI', 'WATER_WORKS', 'RAILWAY', 'AHMEDABAD', 'INCOME_TAX', 'INDORE', 'CHANCE', 'JAIPUR', 'JAIL'],
  // Row 2
  ['JAIL', 'DELHI', 'CHANDIGARH', 'ELECTRIC_COMPANY', 'BEST', 'SHIMLA', 'AMRITSAR', 'COMMUNITY_CHEST', 'SRINAGAR', 'CLUB'],
  // Row 3
  ['CLUB', 'AGRA', 'CHANCE', 'KANPUR', 'PATNA', 'DARJEELING', 'AIR_INDIA', 'CALCUTTA', 'HYDERABAD', 'REST_HOUSE'],
  // Row 4
  ['REST_HOUSE', 'MADRAS', 'COMMUNITY_CHEST', 'BANGALORE', 'WEALTH_TAX', 'OOTACAMUND', 'COCHIN', 'MOTOR_BOAT', 'MARGAO', 'START'],
];

function isSpecial(id: SquareId): id is SpecialSpaceType {
  return Object.prototype.hasOwnProperty.call(SPECIAL_LABELS, id);
}

function toSpace(id: SquareId): BoardSpace {
  if (isSpecial(id)) return { kind: 'SPECIAL', type: id, label: SPECIAL_LABELS[id] };
  if (!Object.prototype.hasOwnProperty.call(PROPERTY_DEEDS, id)) throw new Error(`Board square "${id}" has no title deed`);
  return { kind: 'PROPERTY', propertyKey: id };
}

/**
 * Derives the unique cyclic board from corner-to-corner rows, validating that:
 *  - every row has at least a start corner, one square and an end corner,
 *  - row i ends on the corner row i+1 starts on (corners shared, never duplicated),
 *  - the last row ends on the first row's first square (the board closes),
 *  - corners appear only at row boundaries,
 *  - no non-corner square appears twice (except card squares),
 *  - every square id is a known special square or a property with a deed.
 * Returns the cycle (index 0 = first row's first square). Throws on any violation.
 */
export function deriveBoardCycle(rows: readonly (readonly SquareId[])[], corners: readonly SquareId[] = BOARD_CORNERS): SquareId[] {
  if (rows.length !== corners.length) throw new Error(`Expected ${corners.length} rows, got ${rows.length}`);
  const cycle: SquareId[] = [];
  const seen = new Set<SquareId>();
  rows.forEach((row, i) => {
    const next = rows[(i + 1) % rows.length]!;
    if (row.length < 3) throw new Error(`Row ${i + 1} is too short`);
    if (row[0] !== corners[i]) throw new Error(`Row ${i + 1} must start at ${corners[i]}, starts at ${row[0]}`);
    if (row[row.length - 1] !== next[0]) {
      throw new Error(`Row ${i + 1} ends at ${row[row.length - 1]} but row ${((i + 1) % rows.length) + 1} starts at ${next[0]}`);
    }
    // The end corner belongs to the next row, so each row contributes all but its last square.
    for (const id of row.slice(0, -1)) {
      toSpace(id);
      const isCorner = corners.includes(id);
      if (isCorner && id !== row[0]) throw new Error(`Corner ${id} appears inside row ${i + 1}`);
      if (seen.has(id) && !REPEATABLE_SQUARES.has(id)) throw new Error(`Square ${id} appears more than once`);
      seen.add(id);
      cycle.push(id);
    }
  });
  return cycle;
}

/** The board square ids in play order (index = board position, 0 = Start). */
export const BOARD_CYCLE: readonly SquareId[] = deriveBoardCycle(BOARD_ROWS);

/** Board squares in play order. Derived from BOARD_ROWS — never edit by hand. */
export const BOARD_LAYOUT: readonly BoardSpace[] = BOARD_CYCLE.map(toSpace);

export const BOARD_SIZE = BOARD_LAYOUT.length;

export function normalizePosition(position: number): number {
  return ((position % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE;
}

export function spaceAt(position: number): BoardSpace {
  const space = BOARD_LAYOUT[normalizePosition(position)];
  if (!space) throw new Error(`No board space at ${position}`);
  return space;
}

export function spaceTypeOf(space: BoardSpace): SpaceType {
  if (space.kind === 'PROPERTY') {
    const deed = PROPERTY_DEEDS[space.propertyKey];
    return deed.kind === 'CITY' ? 'PROPERTY' : deed.category;
  }
  switch (space.type) {
    case 'INCOME_TAX':
      return 'TAX';
    default:
      return space.type;
  }
}

/** First position of a special square (Start, Jail, Club, Rest House and the taxes are unique). */
export function positionOfSpecial(type: SpecialSpaceType): number {
  const index = BOARD_LAYOUT.findIndex((s) => s.kind === 'SPECIAL' && s.type === type);
  if (index < 0) throw new Error(`Board has no ${type} space`);
  return index;
}

export function positionsOfSpecial(type: SpecialSpaceType): number[] {
  return BOARD_LAYOUT.flatMap((s, i) => (s.kind === 'SPECIAL' && s.type === type ? [i] : []));
}

export function positionOfProperty(key: PropertyKey): number {
  const index = BOARD_LAYOUT.findIndex((s) => s.kind === 'PROPERTY' && s.propertyKey === key);
  if (index < 0) throw new Error(`Board has no ${key} space`);
  return index;
}

export function positionOfSquare(id: SquareId): number {
  return isSpecial(id) ? positionOfSpecial(id) : positionOfProperty(id);
}

export function spaceName(position: number): string {
  const space = spaceAt(position);
  return space.kind === 'PROPERTY' ? PROPERTY_DEEDS[space.propertyKey].name : space.label;
}

export function squareName(id: SquareId): string {
  return isSpecial(id) ? SPECIAL_LABELS[id] : PROPERTY_DEEDS[id].name;
}
