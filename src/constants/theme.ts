import type { PropertyGroup } from '@/engine/index.ts';

/** Colours used where NativeWind classes can't be (SVG, dynamic values). Mirrors tailwind.config.js. */
export const COLORS = {
  felt: '#0F5132',
  feltDark: '#0A3A24',
  cream: '#FFF8E7',
  ink: '#1F1B16',
  saffron: '#F59E0B',
  brick: '#C2410C',
  /** Physical-board surface and its gilded edge (Board View). */
  board: '#F7F1E1',
  boardEdge: '#D9C58F',
  boardCorner: '#EFE5CC',
  boardLine: '#D8CDB3',
};

// ---------------------------------------------------------------------------
// PROPERTY GROUP colours — "what kind of property is this?"
// The ONLY place property-group colours are defined. Never use them for players.
// ---------------------------------------------------------------------------

export const PROPERTY_DARK_BLUE = '#315D8C';
export const PROPERTY_PURPLE = '#76579A';
export const PROPERTY_GREEN = '#4F8A5B';
export const PROPERTY_PINK = '#C86D8B';
export const PROPERTY_NEUTRAL = '#F4F0E6';

export interface GroupTheme {
  /** The group's identity colour (deed headers, board colour bands). */
  color: string;
  /** Light card background tinted with the group colour. */
  tint: string;
  /** Small marks (dots, strips) that must stay visible on white/cream. */
  mark: string;
  /** Text drawn on top of `color`. */
  onColor: string;
}

export const PROPERTY_GROUP_THEME: Record<PropertyGroup, GroupTheme> = {
  BLUE: { color: PROPERTY_DARK_BLUE, tint: '#E3EAF3', mark: PROPERTY_DARK_BLUE, onColor: '#FFFFFF' },
  PURPLE: { color: PROPERTY_PURPLE, tint: '#ECE5F3', mark: PROPERTY_PURPLE, onColor: '#FFFFFF' },
  GREEN: { color: PROPERTY_GREEN, tint: '#E2EEE3', mark: PROPERTY_GREEN, onColor: '#FFFFFF' },
  PINK: { color: PROPERTY_PINK, tint: '#F7E5EB', mark: PROPERTY_PINK, onColor: '#FFFFFF' },
  TRANSPORT_UTILITY: { color: PROPERTY_NEUTRAL, tint: '#FCFAF4', mark: '#A99E84', onColor: COLORS.ink },
};

// ---------------------------------------------------------------------------
// PLAYER colours — "who is this?"
// Deliberately disjoint from the property-group palette. A player's colour is
// fixed by their seat (their place in the turn order, drawn by the server when
// the game starts and never changed after), so it is stable for the whole game
// on every device.
// ---------------------------------------------------------------------------

export const PLAYER_ORANGE = '#F59E0B';
export const PLAYER_CORAL = '#EF5B63';
export const PLAYER_CYAN = '#18A6B8';
export const PLAYER_SLATE = '#64748B';
export const PLAYER_LEMON = '#E9C46A';
export const PLAYER_COCOA = '#8D5B3E';
export const PLAYER_LIME = '#A3C939';
export const PLAYER_CHARCOAL = '#2F2F33';

export interface PlayerColor {
  name: string;
  color: string;
  /** Text (e.g. the player's initial) drawn on top of `color`. */
  onColor: string;
}

/** One entry per seat, up to BUSINESS_MVP_RULES.players.max. */
export const PLAYER_COLORS: readonly PlayerColor[] = [
  { name: 'Orange', color: PLAYER_ORANGE, onColor: COLORS.ink },
  { name: 'Coral', color: PLAYER_CORAL, onColor: COLORS.ink },
  { name: 'Cyan', color: PLAYER_CYAN, onColor: COLORS.ink },
  { name: 'Slate', color: PLAYER_SLATE, onColor: '#FFFFFF' },
  { name: 'Lemon', color: PLAYER_LEMON, onColor: COLORS.ink },
  { name: 'Cocoa', color: PLAYER_COCOA, onColor: '#FFFFFF' },
  { name: 'Lime', color: PLAYER_LIME, onColor: COLORS.ink },
  { name: 'Charcoal', color: PLAYER_CHARCOAL, onColor: '#FFFFFF' },
];

/** A player's identity colour, from their seat. */
export function playerColor(player: { seat: number }): PlayerColor {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[((player.seat % n) + n) % n]!;
}

/** First letter of a player's name, for colour-independent identification. */
export function playerInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
