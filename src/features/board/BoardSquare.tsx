import { memo, useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { SpecialSpaceType } from '@/engine/index.ts';
import { COLORS, PROPERTY_GROUP_THEME, playerColor } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import type { BoardMetrics, BoardSpaceViewModel, Rect, SquareSlot } from './boardModel';

/** Small, restrained pictograms for squares that have no colour group. */
export const SPECIAL_ICONS: Record<SpecialSpaceType, string> = {
  START: '🏁',
  JAIL: '🔒',
  CLUB: '🥂',
  REST_HOUSE: '🛏️',
  INCOME_TAX: '🧾',
  WEALTH_TAX: '💎',
  CHANCE: '❓',
  COMMUNITY_CHEST: '📦',
};

/** Smallest font a name is ever drawn at; decorations are dropped long before this. */
const MIN_FONT = 4.5;
/** Line height of board text, as a multiple of its font size. */
const LINE = 1.15;
const PAD = 1;

/**
 * Board lettering is set in the platform's condensed face: a square is narrow,
 * and a condensed bold fits a whole place name ("Chandigarh") on one line at a
 * size a regular face could only reach by breaking the word.
 */
const BOARD_FONT = Platform.select<string | undefined>({ android: 'sans-serif-condensed', ios: 'HelveticaNeue-CondensedBold', default: undefined });
/** Where there is no condensed face (web), letters are this much wider. */
const FACE_WIDTH = BOARD_FONT ? 1 : 1.18;
const SAFETY = 1.05;

/**
 * Board text is part of a drawing, not of the app's reading text: it is sized
 * from the board's geometry only. The phone's font-size setting and Android's
 * extra font padding must not change it.
 */
const BOARD_TEXT = { allowFontScaling: false, ellipsizeMode: 'clip', numberOfLines: 1 } as const;
const NO_PAD: TextStyle = { includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center', fontFamily: BOARD_FONT };

/** Advance width of one bold condensed character, in ems. */
function charEms(ch: string): number {
  if ("ijlI.,'-".includes(ch)) return 0.26;
  if (ch === ' ') return 0.24;
  if ('tfr'.includes(ch)) return 0.34;
  if ('mwMW'.includes(ch)) return 0.8;
  if (ch >= 'A' && ch <= 'Z') return 0.6;
  return 0.5;
}

/** Estimated width of `text` in ems (slightly generous, so a line is never clipped). */
export function textEms(text: string): number {
  let ems = 0;
  for (const ch of text) ems += charEms(ch);
  return ems * FACE_WIDTH * SAFETY;
}

/**
 * The lines a square's name is drawn on, and their font — decided here, never
 * by the platform's text wrapping. A word is NEVER broken: a long name gets a
 * smaller font instead. A two-word name goes on one line or two, whichever
 * lets it be drawn larger in a `width` × `height` box. `below` is what must
 * still fit under the name (the price), in lines of the name's own font.
 */
export function fitName(name: string, width: number, height: number, base: number, below = 0): { lines: string[]; font: number } {
  const words = name.trim().split(/\s+/);
  const options = [[words.join(' ')]];
  if (words.length > 1) {
    const half = Math.ceil(words.length / 2);
    options.push([words.slice(0, half).join(' '), words.slice(half).join(' ')]);
  }
  let best = { lines: options[0]!, font: 0 };
  for (const lines of options) {
    const font = Math.min(base, width / Math.max(...lines.map(textEms)), height / ((lines.length + below) * LINE));
    if (font > best.font) best = { lines, font };
  }
  return best;
}

function describe(space: BoardSpaceViewModel): string {
  const parts = [space.name];
  if (space.purchasePrice !== null) parts.push(formatINR(space.purchasePrice));
  if (space.propertyKey) parts.push(space.owner ? `owned by ${space.owner.name}` : 'available');
  if (space.hotel) parts.push('hotel');
  else if (space.houses > 0) parts.push(`${space.houses} house${space.houses === 1 ? '' : 's'}`);
  if (space.mortgaged) parts.push('mortgaged');
  return parts.join(', ');
}

/** The cell: an absolutely positioned, clipped box whose place and size come only from the board layout. */
function cellStyle(slot: SquareSlot, backgroundColor: string): ViewStyle {
  return {
    position: 'absolute',
    left: slot.x,
    top: slot.y,
    width: slot.width,
    height: slot.height,
    borderWidth: 0.5,
    borderColor: COLORS.boardLine,
    overflow: 'hidden',
    backgroundColor,
  };
}

interface CellProps {
  space: BoardSpaceViewModel;
  style: ViewStyle;
  onPress?: (index: number) => void;
  children: ReactNode;
}

/**
 * A tappable cell — READ-ONLY: a tap only opens information, it never sends a
 * game action.
 *
 * The style is a plain object on purpose. Pressable's `style={({ pressed }) => …}`
 * form is NOT understood by NativeWind's native runtime (it takes the function
 * for an empty style object), which silently dropped every square's position and
 * size on Android and collapsed the board into a pile at its top-left corner.
 * Press feedback uses state instead.
 */
function PressableCell({ space, style, onPress, children }: CellProps & { onPress: (index: number) => void }) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      style={pressed ? { ...style, opacity: 0.7 } : style}
      testID={`board-square-${space.index}`}
      accessibilityRole="button"
      accessibilityLabel={describe(space)}
      accessibilityHint="Shows details"
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => onPress(space.index)}
    >
      {children}
    </Pressable>
  );
}

function Cell({ space, style, onPress, children }: CellProps) {
  if (onPress) {
    return (
      <PressableCell space={space} style={style} onPress={onPress}>
        {children}
      </PressableCell>
    );
  }
  return (
    <View style={style} testID={`board-square-${space.index}`} accessible accessibilityLabel={describe(space)}>
      {children}
    </View>
  );
}

/** A glyph (emoji) in a box of exactly `box`×`box`: whatever the platform's emoji metrics, it can't spill. */
function Glyph({ children, box }: { children: string; box: number }) {
  return (
    <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <Text {...BOARD_TEXT} style={{ includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center', fontSize: box * 0.68 }}>
        {children}
      </Text>
    </View>
  );
}

/** One line of text in a row of exactly `width` × `font·LINE`. */
function Line({ children, width, font, style, testID }: { children: string; width: number; font: number; style: TextStyle; testID?: string }) {
  return (
    <View style={{ width, height: font * LINE, justifyContent: 'center', overflow: 'hidden' }}>
      <Text {...BOARD_TEXT} testID={testID} style={[NO_PAD, style, { width, fontSize: font, lineHeight: font * LINE }]}>
        {children}
      </Text>
    </View>
  );
}

/**
 * What a square says, in a box of exactly `box` size: [icon] name [price], every
 * row a fixed height computed here. Priority when the box is small: name, then
 * price, then the decorative icon (dropped first).
 */
function SquareContent({ space, box, metrics, icon }: { space: BoardSpaceViewModel; box: Rect; metrics: BoardMetrics; icon?: string }) {
  const width = Math.max(1, box.width - 2 * PAD);
  const height = Math.max(1, box.height - 2 * PAD);
  const base = space.isCorner ? metrics.nameFont * 1.1 : metrics.nameFont;
  const price = space.purchasePrice !== null ? formatINR(space.purchasePrice) : null;
  const fit = (iconBox: number) => fitName(space.name, width, height - iconBox, base, price ? 1 : 0);
  let iconBox = icon ? Math.min(box.height * (space.isCorner ? 0.46 : 0.4), width) : 0;
  // Readability first: the icon is decoration, and is dropped rather than squeezing the name.
  if (iconBox && fit(iconBox).font < fit(0).font * 0.85) iconBox = 0;
  const { lines, font: fitted } = fit(iconBox);
  const font = Math.max(MIN_FONT, fitted);
  // The price follows the name: never the louder of the two.
  const priceFont = price ? Math.max(MIN_FONT, Math.min(metrics.priceFont, font, width / textEms(price))) : 0;

  return (
    <View
      testID={`board-content-${space.index}`}
      style={{ position: 'absolute', ...box, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: space.mortgaged ? 0.45 : 1 }}
    >
      {iconBox ? <Glyph box={iconBox}>{icon!}</Glyph> : null}
      {lines.map((line, i) => (
        <Line key={i} width={width} font={font} style={{ fontWeight: '700', color: COLORS.ink }}>
          {line}
        </Line>
      ))}
      {price ? (
        <Line width={width} font={priceFont} testID={`board-price-${space.propertyKey}`} style={{ fontWeight: '600', color: '#5B5347' }}>
          {price}
        </Line>
      ) : null}
    </View>
  );
}

/** Buildings are neutral playing pieces: the same cream house whoever owns the property. */
const PIECE = { fill: '#FFFDF7', stroke: COLORS.ink };

function House({ size, testID }: { size: number; testID: string }) {
  return (
    <View testID={testID} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 10 10">
        <Path d="M5 0.7 L9.5 4.9 H8.3 V9.3 H1.7 V4.9 H0.5 Z" fill={PIECE.fill} stroke={PIECE.stroke} strokeWidth={0.7} strokeLinejoin="round" />
      </Svg>
    </View>
  );
}

/** A hotel: one larger block with windows, in place of the houses. */
function Hotel({ size, testID }: { size: number; testID: string }) {
  return (
    <View testID={testID} style={{ width: size * 1.5, height: size }}>
      <Svg width={size * 1.5} height={size} viewBox="0 0 15 10">
        <Path d="M1 9.3 V2.6 H4.2 V0.8 H10.8 V2.6 H14 V9.3 Z" fill={PIECE.fill} stroke={PIECE.stroke} strokeWidth={0.7} strokeLinejoin="round" />
        <Path d="M3.4 4.6 H5 M6.7 4.6 H8.3 M10 4.6 H11.6 M3.4 6.9 H5 M10 6.9 H11.6 M7.5 6.6 V9.3" stroke={PIECE.stroke} strokeWidth={0.9} />
      </Svg>
    </View>
  );
}

/**
 * The building strip: the property's group colour along the INNER edge of its
 * square (the edge facing the board centre), holding its houses / hotel (and
 * the mortgage mark). It runs along that edge — across on the top and bottom
 * rows, down on the side columns — and four houses always fit its length. A
 * sliver along its inner edge is kept clear of buildings.
 */
/** The edge of the strip kept clear of buildings: the square's inner edge. */
const ACCENT_PADDING = { top: 'paddingBottom', bottom: 'paddingTop', left: 'paddingRight', right: 'paddingLeft' } as const;

function BuildingStrip({ space, slot }: { space: BoardSpaceViewModel; slot: SquareSlot }) {
  const theme = PROPERTY_GROUP_THEME[space.propertyGroup!];
  const place = slot.parts.band!;
  const vertical = slot.side === 'left' || slot.side === 'right';
  const gap = 1;
  const accent = vertical ? slot.parts.owner!.width : slot.parts.owner!.height;
  const thickness = (vertical ? place.width : place.height) - accent;
  const length = vertical ? place.height : place.width;
  const piece = Math.max(2, Math.min(thickness * 0.86, (length - 2 - 3 * gap) / 4));
  return (
    <View
      testID={`board-band-${space.propertyKey}`}
      style={{
        position: 'absolute',
        ...place,
        backgroundColor: theme.color,
        // The cream transport/utility band needs an outline to read as a band.
        borderColor: theme.mark,
        borderWidth: space.propertyGroup === 'TRANSPORT_UTILITY' ? 0.75 : 0,
        flexDirection: vertical ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap,
        overflow: 'hidden',
        [ACCENT_PADDING[slot.side]]: accent,
      }}
    >
      {space.hotel ? <Hotel size={piece} testID={`board-hotel-${space.propertyKey}`} /> : null}
      {Array.from({ length: space.houses }, (_, i) => (
        <House key={i} size={piece} testID={`board-house-${space.propertyKey}`} />
      ))}
      {space.mortgaged ? (
        <View
          testID={`board-mortgage-${space.propertyKey}`}
          style={{ width: piece * 0.8, height: piece * 0.8, borderRadius: piece / 2, backgroundColor: COLORS.ink, borderWidth: 0.5, borderColor: '#FFFFFF' }}
        />
      ) : null}
    </View>
  );
}

/** Who owns it: a thin line in the owner's player colour on the card's outer edge, opposite the strip — never a letter or a badge. */
function OwnerStrip({ space, slot }: { space: BoardSpaceViewModel; slot: SquareSlot }) {
  if (!space.owner) return null;
  return <View testID={`board-owner-strip-${space.propertyKey}`} style={{ position: 'absolute', ...slot.parts.owner!, backgroundColor: playerColor(space.owner).color }} />;
}

interface SquareProps {
  space: BoardSpaceViewModel;
  slot: SquareSlot;
  metrics: BoardMetrics;
  onPress?: (index: number) => void;
}

/** Start / Jail / Club / Rest House: icon over name, in exactly one cell. */
function CornerBoardSquare({ space, slot, metrics, onPress }: SquareProps) {
  return (
    <Cell space={space} onPress={onPress} style={cellStyle(slot, COLORS.boardCorner)}>
      <SquareContent space={space} metrics={metrics} icon={SPECIAL_ICONS[space.specialType!]} box={slot.parts.content} />
    </Cell>
  );
}

/** A property: name + price, the building strip on the inner edge and the owner accent on the outer one. */
function PropertyBoardSquare({ space, slot, metrics, onPress }: SquareProps) {
  const theme = PROPERTY_GROUP_THEME[space.propertyGroup!];
  return (
    <Cell space={space} onPress={onPress} style={cellStyle(slot, theme.tint)}>
      <BuildingStrip space={space} slot={slot} />
      <SquareContent space={space} metrics={metrics} box={slot.parts.content} />
      <OwnerStrip space={space} slot={slot} />
    </Cell>
  );
}

/** Chance, Community Chest and the tax squares: icon (when it fits) over name. */
function SpecialBoardSquare({ space, slot, metrics, onPress }: SquareProps) {
  return (
    <Cell space={space} onPress={onPress} style={cellStyle(slot, COLORS.board)}>
      <SquareContent space={space} metrics={metrics} icon={SPECIAL_ICONS[space.specialType!]} box={slot.parts.content} />
    </Cell>
  );
}

/**
 * One square of the physical board: exactly one cell of the board layout.
 * Purely visual — no state beyond press feedback; an optional read-only
 * `onPress` for opening details. Nothing in here is rotated and nothing is
 * sized by its content; the token lane (see boardModel) is left empty for the
 * tokens drawn above the squares.
 * Property group colour = what the property is (tint + building strip);
 * player colour = who owns it (thin accent line).
 */
export const BoardSquare = memo(function BoardSquare(props: SquareProps) {
  if (props.space.isCorner) return <CornerBoardSquare {...props} />;
  return props.space.propertyKey ? <PropertyBoardSquare {...props} /> : <SpecialBoardSquare {...props} />;
});
