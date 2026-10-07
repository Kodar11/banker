/**
 * BUSINESS V1 — static board data.
 *
 * Two kinds of data live here and they are deliberately kept apart:
 *
 * 1. PROPERTY_DEEDS — AUTHORITATIVE. Transcribed from photographs of the
 *    physical title-deed cards. Do not "normalise" or adjust these values.
 *
 * 2. BOARD_LAYOUT — ASSUMED ORDER. The photographs did not establish the order
 *    of squares around the board. The order below is a placeholder that makes
 *    movement work. Edit it to match your physical board before playtesting
 *    (tests/engine/businessData.test.ts keeps the layout internally consistent).
 *
 * Runtime state (owner, houses, hotel, mortgage) lives in the database, never here.
 */

export const RULES_VERSION = 'BUSINESS_V1' as const;

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
  | 'SIMLA'
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
  | 'MARGOA'
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
  SIMLA: city('SIMLA', 'Simla', 'PURPLE', 2200, [200, 1000, 2750, 4500], 6000, 3500, 3500, 1100),
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
  MARGOA: city('MARGOA', 'Margoa', 'PINK', 4000, [400, 2200, 3500, 5000], 6500, 4500, 4500, 2000),

  // ---------------- TRANSPORT / UTILITY ----------------
  RAILWAY: {
    kind: 'TRANSPORT_UTILITY',
    key: 'RAILWAY',
    name: 'Railway',
    group: 'TRANSPORT_UTILITY',
    price: 9500,
    rent: { type: 'FIXED', base: 1000, pairedWith: 'BEST', pairedRent: 1350 },
    mortgageValue: 4750,
  },
  // Note: Air India has a photographed title deed but was not in the photographed
  // board property list. Included because its deed values are known.
  AIR_INDIA: {
    kind: 'TRANSPORT_UTILITY',
    key: 'AIR_INDIA',
    name: 'Air India',
    group: 'TRANSPORT_UTILITY',
    price: 10500,
    rent: { type: 'FIXED', base: 1200, pairedWith: 'WATER_WORKS', pairedRent: 1350 },
    mortgageValue: 4750,
  },
  MOTOR_BOAT: {
    kind: 'TRANSPORT_UTILITY',
    key: 'MOTOR_BOAT',
    name: 'Motor Boat',
    group: 'TRANSPORT_UTILITY',
    price: 5500,
    rent: { type: 'DICE_MULTIPLIER', multiplier: 100, pairedWith: 'ELECTRIC_COMPANY', pairedMultiplier: 200 },
    mortgageValue: 1750,
  },
  BEST: {
    kind: 'TRANSPORT_UTILITY',
    key: 'BEST',
    name: 'BEST',
    group: 'TRANSPORT_UTILITY',
    price: 3500,
    rent: { type: 'FIXED', base: 600, pairedWith: 'RAILWAY', pairedRent: 1350 },
    mortgageValue: 1750,
  },
  ELECTRIC_COMPANY: {
    kind: 'TRANSPORT_UTILITY',
    key: 'ELECTRIC_COMPANY',
    name: 'Electric Company',
    group: 'TRANSPORT_UTILITY',
    price: 2500,
    rent: { type: 'DICE_MULTIPLIER', multiplier: 50, pairedWith: 'MOTOR_BOAT', pairedMultiplier: 100 },
    mortgageValue: 1750,
  },
  WATER_WORKS: {
    kind: 'TRANSPORT_UTILITY',
    key: 'WATER_WORKS',
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

export type SpecialSpaceType = 'START' | 'JAIL' | 'REST_HOUSE' | 'INCOME_TAX' | 'CHANCE' | 'COMMUNITY_CHEST';

export type BoardSpace =
  | { kind: 'PROPERTY'; propertyKey: PropertyKey }
  | { kind: 'SPECIAL'; type: SpecialSpaceType; label: string };

const P = (propertyKey: PropertyKey): BoardSpace => ({ kind: 'PROPERTY', propertyKey });
const S = (type: SpecialSpaceType, label: string): BoardSpace => ({ kind: 'SPECIAL', type, label });

/**
 * ASSUMED ORDER — verify against the physical board.
 * Index = boardPosition (0 = START, moving forward increases the index).
 * Every property must appear exactly once; specials may repeat.
 */
export const BOARD_LAYOUT: readonly BoardSpace[] = [
  S('START', 'Start'), // 0
  P('INDORE'),
  S('COMMUNITY_CHEST', 'Community Chest'),
  P('PATNA'),
  S('INCOME_TAX', 'Income Tax'),
  P('RAILWAY'), // 5
  P('AGRA'),
  S('CHANCE', 'Chance'),
  P('JAIPUR'),
  S('JAIL', 'Jail'),
  P('KANPUR'), // 10
  P('ELECTRIC_COMPANY'),
  P('SIMLA'),
  P('AMRITSAR'),
  P('BEST'),
  P('BANGALORE'), // 15
  S('COMMUNITY_CHEST', 'Community Chest'),
  P('SRINAGAR'),
  S('REST_HOUSE', 'Rest House'),
  P('MADRAS'),
  S('CHANCE', 'Chance'), // 20
  P('OOTACAMUND'),
  P('CHANDIGARH'),
  P('MOTOR_BOAT'),
  P('COCHIN'),
  P('MARGOA'), // 25
  P('WATER_WORKS'),
  P('DELHI'),
  S('COMMUNITY_CHEST', 'Community Chest'),
  P('DARJEELING'),
  P('AIR_INDIA'), // 30
  P('HYDERABAD'),
  P('AHMEDABAD'),
  S('CHANCE', 'Chance'),
  P('CALCUTTA'),
  P('MUMBAI'), // 35
];

export const BOARD_SIZE = BOARD_LAYOUT.length;

export function spaceAt(position: number): BoardSpace {
  const space = BOARD_LAYOUT[((position % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE];
  if (!space) throw new Error(`No board space at ${position}`);
  return space;
}

export function positionOfSpecial(type: SpecialSpaceType): number {
  const index = BOARD_LAYOUT.findIndex((s) => s.kind === 'SPECIAL' && s.type === type);
  if (index < 0) throw new Error(`Board has no ${type} space`);
  return index;
}

export function positionOfProperty(key: PropertyKey): number {
  const index = BOARD_LAYOUT.findIndex((s) => s.kind === 'PROPERTY' && s.propertyKey === key);
  if (index < 0) throw new Error(`Board has no ${key} space`);
  return index;
}

export function spaceName(position: number): string {
  const space = spaceAt(position);
  return space.kind === 'PROPERTY' ? PROPERTY_DEEDS[space.propertyKey].name : space.label;
}
