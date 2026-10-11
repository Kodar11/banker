import type { ReactNode } from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { BUSINESS_MVP_RULES, GAME_MODE_NAMES, getDeed, positionOfProperty, spaceAt, type BoardSpace, type CityDeed, type PropertyKey } from '@/engine/index.ts';
import { COLORS, playerColor, PROPERTY_GROUP_THEME, type PlayerColor } from '@/constants/theme';
import { HOUSE_ICON, SPECIAL_ICONS } from '@/features/board/BoardSquare';
import { formatINR } from '@/utils/currency';

/**
 * The introduction's playing pieces: a cropped corner of the board and the things that sit on
 * it. Drawings only — they read nothing from a game and can change nothing in one. Everything
 * is laid out in the scene's own units (a STAGE-sized canvas that the screen scales to fit), so
 * no piece is ever sized by the phone's font setting.
 */
export const STAGE = { width: 320, height: 236 };

export const TILE = { width: 74, height: 98, gap: 2, left: 9, top: 129, band: 20, owner: 6 };
export const TOKEN = 22;
export const DIE = 34;
export const COIN = 16;
export const HOUSE = 16;
export const CARD = { width: 60, height: 78 };
export const PURSE = { width: 98, height: 30 };

/** The property the story is about, and how far the tokens travel to reach it (the dice total). */
const DESTINATION: PropertyKey = 'DARJEELING';
export const ROLL = [1, 2] as const;
const STEPS = ROLL[0] + ROLL[1];

export interface SceneTile {
  name: string;
  /** Null for a square nobody can buy. */
  deed: CityDeed | null;
  icon: string | null;
}

function toTile(space: BoardSpace): SceneTile {
  if (space.kind === 'SPECIAL') return { name: space.label, deed: null, icon: SPECIAL_ICONS[space.type] };
  const deed = getDeed(space.propertyKey);
  return { name: deed.name, deed: deed.kind === 'CITY' ? deed : null, icon: null };
}

/**
 * A real stretch of the board, read from the board data: the squares a token crosses on its way
 * to the destination, in play order. Names, colours and prices are the game's own.
 */
export const STRIP: readonly SceneTile[] = Array.from({ length: STEPS + 1 }, (_, i) => toTile(spaceAt(positionOfProperty(DESTINATION) - STEPS + i)));
export const DESTINATION_INDEX = STEPS;

function cityAt(index: number): CityDeed {
  const deed = STRIP[index]?.deed;
  if (!deed) throw new Error(`Onboarding strip square ${index} is not a city`);
  return deed;
}

/** The property that is bought, and the one a rival offers for it in the trade scene. */
export const BOUGHT = cityAt(DESTINATION_INDEX);
export const RIVAL_INDEX = STRIP.findIndex((tile, i) => tile.deed !== null && i !== DESTINATION_INDEX);
export const OFFERED = cityAt(RIVAL_INDEX);
/** Rent on the bare site with no colour set: what a visitor pays in the scene. */
export const RENT = BOUGHT.rent[0];

// --- The finale: the same properties, later in the game. Every figure is read from the deeds and the rules. ---

/** Rent on the bought property as it is developed: one, two and three houses, then a hotel. */
export const RENT_LADDER = [BOUGHT.rent[1], BOUGHT.rent[2], BOUGHT.rent[3], BOUGHT.hotelRent] as const;
export const MAX_HOUSES = BUSINESS_MVP_RULES.building.maxHouses;
/** What the bank lends against the mortgaged deed. */
export const MORTGAGE_CASH = OFFERED.mortgageValue;
/** The square nobody owns yet, which goes to auction: the one next to the bought property. */
export const AUCTION_INDEX = DESTINATION_INDEX - 1;
export const AUCTIONED = cityAt(AUCTION_INDEX);
const { minimumOpeningBid, minimumIncrement } = BUSINESS_MVP_RULES.auction;
/** Three bids the rules would accept: each a whole number of increments, each above the last. */
export const AUCTION_BIDS = [0.5, 0.7, 0.9].map((share) => Math.max(minimumOpeningBid, Math.round((AUCTIONED.price * share) / minimumIncrement) * minimumIncrement)) as [number, number, number];
/** Insurance exists only in this mode, and the scene says so wherever it shows it. */
export const INSURANCE_MODE = GAME_MODE_NAMES.intermediate;

/** Seats 0–3: the owner, the rival, and the two players who join later. */
export const SEATS = [0, 1, 2, 3].map((seat) => playerColor({ seat })) as [PlayerColor, PlayerColor, PlayerColor, PlayerColor];

export const tileX = (index: number) => TILE.left + index * (TILE.width + TILE.gap);
/** Where a token stands on a square; `shift` moves it sideways when the square is shared. */
export const tokenSpot = (index: number, shift = 0) => ({ x: tileX(index) + (TILE.width - TOKEN) / 2 + shift, y: TILE.top + 62 });
/** How far apart two tokens on one square stand from its middle. */
export const SHARE = 12;

/** Text in a scene is part of a drawing: sized by the scene, never by the phone's font setting. */
const DRAWN = { allowFontScaling: false, numberOfLines: 1 } as const;
const FLAT: TextStyle = { includeFontPadding: false, textAlign: 'center' };
const SHADOW: ViewStyle = { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 2 }, elevation: 3 };

/** The cropped board: its gilded edge and surface. Squares and pieces are drawn on top. */
export function BoardCrop({ children }: { children: ReactNode }) {
  return (
    <View style={{ width: STAGE.width, height: STAGE.height, borderRadius: 14, backgroundColor: COLORS.board }}>
      {/* The edge is its own layer, so a piece's place is measured from the stage's corner, not from inside a border. */}
      <View style={{ position: 'absolute', left: 0, top: 0, width: STAGE.width, height: STAGE.height, borderRadius: 14, borderWidth: 2, borderColor: COLORS.boardEdge }} />
      {children}
    </View>
  );
}

/** One square, drawn like the board's own: colour band on the inner edge, name and price below. */
export function Tile({ tile, index }: { tile: SceneTile; index: number }) {
  const theme = tile.deed ? PROPERTY_GROUP_THEME[tile.deed.group] : null;
  return (
    <View
      style={{
        position: 'absolute',
        left: tileX(index),
        top: TILE.top,
        width: TILE.width,
        height: TILE.height,
        borderRadius: 5,
        borderWidth: 0.5,
        borderColor: COLORS.boardLine,
        backgroundColor: theme ? theme.tint : COLORS.boardCorner,
        overflow: 'hidden',
        alignItems: 'center',
      }}
    >
      {theme ? <View style={{ alignSelf: 'stretch', height: TILE.band, backgroundColor: theme.color }} /> : <Text {...DRAWN} style={[FLAT, { fontSize: 15, lineHeight: TILE.band + 2, marginTop: 2 }]}>{tile.icon}</Text>}
      <Text {...DRAWN} style={[FLAT, { marginTop: 5, fontSize: 11, lineHeight: 14, fontWeight: '800', color: COLORS.ink }]}>
        {tile.name}
      </Text>
      {tile.deed ? (
        <Text {...DRAWN} style={[FLAT, { fontSize: 9, lineHeight: 12, fontWeight: '600', color: COLORS.ink, opacity: 0.65 }]}>
          {formatINR(tile.deed.price)}
        </Text>
      ) : null}
    </View>
  );
}

/** Who owns a square: the owner's colour along its outer edge, as on the real board. */
export function OwnerEdge({ seat }: { seat: PlayerColor }) {
  return <View style={{ width: TILE.width, height: TILE.owner, borderBottomLeftRadius: 5, borderBottomRightRadius: 5, backgroundColor: seat.color }} />;
}

/** Ownership that does not rely on colour: a tick in the owner's colour on the square's corner. */
export function OwnerBadge({ seat }: { seat: PlayerColor }) {
  return (
    <View style={[SHADOW, { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: '#FFFFFF', backgroundColor: seat.color, alignItems: 'center', justifyContent: 'center' }]}>
      <Text {...DRAWN} style={[FLAT, { fontSize: 10, lineHeight: 13, fontWeight: '900', color: seat.onColor }]}>
        ✓
      </Text>
    </View>
  );
}

/** The glow around a square that has just been bought. */
export function TileGlow() {
  return <View style={{ width: TILE.width + 6, height: TILE.height + 6, borderRadius: 8, borderWidth: 3, borderColor: COLORS.saffron }} />;
}

/** A playing piece, drawn like the board's tokens: the player's colour and a soft highlight. */
export function TokenPiece({ seat }: { seat: PlayerColor }) {
  return (
    <View style={[SHADOW, { width: TOKEN, height: TOKEN, borderRadius: TOKEN / 2, borderWidth: 2, borderColor: '#FFFFFF', backgroundColor: seat.color }]}>
      <View style={{ position: 'absolute', left: '18%', top: '14%', width: '34%', height: '34%', borderRadius: TOKEN, backgroundColor: '#FFFFFF', opacity: 0.4 }} />
    </View>
  );
}

/** Where the pips sit on a die face, as fractions of its side. */
const PIPS: Record<1 | 2, readonly (readonly [number, number])[]> = {
  1: [[0.5, 0.5]],
  2: [
    [0.29, 0.29],
    [0.71, 0.71],
  ],
};

/** The pips of one face. Faces are layered so a die can change what it shows while it tumbles. */
export function DieFace({ value }: { value: 1 | 2 }) {
  const pip = DIE * 0.2;
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, width: DIE, height: DIE }}>
      {PIPS[value].map(([x, y]) => (
        <View key={`${x}-${y}`} style={{ position: 'absolute', left: DIE * x - pip / 2, top: DIE * y - pip / 2, width: pip, height: pip, borderRadius: pip / 2, backgroundColor: COLORS.ink }} />
      ))}
    </View>
  );
}

export function DieBody({ children }: { children: ReactNode }) {
  return <View style={[SHADOW, { width: DIE, height: DIE, borderRadius: 8, borderWidth: 1.5, borderColor: COLORS.ink, backgroundColor: '#FFFFFF' }]}>{children}</View>;
}

export function Coin({ size = COIN }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: COLORS.saffronDark, backgroundColor: COLORS.saffron, alignItems: 'center', justifyContent: 'center' }}>
      <Text {...DRAWN} style={[FLAT, { fontSize: size * 0.56, lineHeight: size * 0.75, fontWeight: '900', color: COLORS.ink }]}>
        ₹
      </Text>
    </View>
  );
}

/** A house, the same piece the board draws, boxed so it can never spill out of the colour band. */
export function HousePiece() {
  return (
    <View style={{ width: HOUSE, height: HOUSE, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <Text {...DRAWN} style={[FLAT, { fontSize: HOUSE * 0.78, lineHeight: HOUSE }]}>
        {HOUSE_ICON}
      </Text>
    </View>
  );
}

/** A player's money, by the board: their token and their coins. The amount is drawn by the scene. */
export function Purse({ seat, children }: { seat: PlayerColor; children?: ReactNode }) {
  return (
    <View style={[SHADOW, { width: PURSE.width, height: PURSE.height, borderRadius: PURSE.height / 2, borderWidth: 1, borderColor: COLORS.boardLine, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, gap: 4 }]}>
      <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: '#FFFFFF', backgroundColor: seat.color, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 1, shadowOffset: { width: 0, height: 0 }, elevation: 1 }} />
      <Coin size={14} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
    </View>
  );
}

/** An amount of money moving into or out of a purse. The sign says which, so colour never has to. */
export function Amount({ value }: { value: number }) {
  return (
    <Text {...DRAWN} style={[FLAT, { fontSize: 12, lineHeight: 15, fontWeight: '900', color: value < 0 ? COLORS.brick : COLORS.felt }]}>
      {`${value < 0 ? '−' : '+'}${formatINR(Math.abs(value))}`}
    </Text>
  );
}

/** A title deed in a player's hand: the property's colour and name, and whose card it is. */
export function DeedCard({ deed, seat }: { deed: CityDeed; /** Whose card it is; none while the bank still holds it. */ seat?: PlayerColor }) {
  const theme = PROPERTY_GROUP_THEME[deed.group];
  return (
    <View style={[SHADOW, { width: CARD.width, height: CARD.height, borderRadius: 7, borderWidth: 1, borderColor: COLORS.boardLine, backgroundColor: '#FFFFFF', overflow: 'hidden' }]}>
      <View style={{ height: 24, backgroundColor: theme.color, alignItems: 'center', justifyContent: 'center' }}>
        <Text {...DRAWN} style={[FLAT, { fontSize: 9, lineHeight: 12, fontWeight: '900', color: theme.onColor }]}>
          {deed.name}
        </Text>
      </View>
      <View style={{ paddingHorizontal: 8, paddingTop: 9, gap: 6 }}>
        {[36, 28, 32].map((width) => (
          <View key={width} style={{ width, height: 3, borderRadius: 2, backgroundColor: COLORS.boardLine }} />
        ))}
      </View>
      {seat ? <View style={{ position: 'absolute', right: 5, bottom: 5, width: 13, height: 13, borderRadius: 7, borderWidth: 1.5, borderColor: '#FFFFFF', backgroundColor: seat.color, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 1, shadowOffset: { width: 0, height: 0 }, elevation: 1 }} /> : null}
    </View>
  );
}

export const MARK = 28;

/** A round marker carrying one of the app's own pictograms. */
function Mark({ icon }: { icon: string }) {
  return (
    <View style={[SHADOW, { width: MARK, height: MARK, borderRadius: MARK / 2, borderWidth: 1.5, borderColor: COLORS.boardEdge, backgroundColor: COLORS.cream, alignItems: 'center', justifyContent: 'center' }]}>
      <Text {...DRAWN} style={[FLAT, { fontSize: 14, lineHeight: 19 }]}>
        {icon}
      </Text>
    </View>
  );
}

/** The moment a deal is struck. */
export const DealMark = () => <Mark icon="🤝" />;
/** The bank, as the app draws it everywhere. */
export const BankMark = () => <Mark icon="🏦" />;
/** Sold at auction. */
export const GavelMark = () => <Mark icon="🔨" />;

/** A hotel on a colour band: one piece in place of the houses. */
export function HotelPiece() {
  return (
    <View style={{ width: HOUSE + 2, height: HOUSE, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <Text {...DRAWN} style={[FLAT, { fontSize: HOUSE * 0.78, lineHeight: HOUSE }]}>
        🏨
      </Text>
    </View>
  );
}

/** The board's mortgage mark: a dark disc on the colour band. The property is pledged, not sold. */
export function MortgageMark() {
  return <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: '#FFFFFF', backgroundColor: COLORS.ink }} />;
}

/** A mortgaged square is drawn faded, as on the board: it earns nothing until it is redeemed. */
export function MortgageVeil({ deed }: { deed: CityDeed }) {
  return <View style={{ width: TILE.width, height: TILE.height - TILE.band - TILE.owner, backgroundColor: PROPERTY_GROUP_THEME[deed.group].tint }} />;
}

export const TAG = { height: 18 };

/** A small label by the board. `children` are drawn centred in it, on top of one another. */
export function Tag({ width, children }: { width: number; children: ReactNode }) {
  return (
    <View style={[SHADOW, { width, height: TAG.height, borderRadius: TAG.height / 2, borderWidth: 1, borderColor: COLORS.boardLine, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }]}>{children}</View>
  );
}

export function TagText({ children }: { children: string }) {
  return (
    <Text {...DRAWN} style={[FLAT, { fontSize: 9, lineHeight: 12, fontWeight: '900', color: COLORS.ink }]}>
      {children}
    </Text>
  );
}
