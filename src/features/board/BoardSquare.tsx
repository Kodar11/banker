import { memo, useState, type ReactNode } from 'react';
import { Pressable, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import type { SpecialSpaceType } from '@/engine/index.ts';
import { COLORS, PROPERTY_GROUP_THEME, playerColor } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import type { BoardSide, BoardSpaceViewModel, SquareSlot } from './boardModel';

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

export interface SquareMetrics {
  band: number;
  nameFont: number;
  priceFont: number;
  ownerStrip: number;
}

/**
 * Where the colour band sits in a cell. Top and bottom rows carry it on the edge
 * facing the board centre. The side columns carry it along the top of the cell
 * instead: a band down the side would take its thickness out of the cell's WIDTH,
 * which is exactly what a name needs.
 */
const BAND_EDGE: Record<BoardSide, 'top' | 'bottom'> = { bottom: 'top', top: 'bottom', left: 'top', right: 'top' };

/** Smallest font a name is ever drawn at; decorations are dropped long before this. */
const MIN_FONT = 4.5;
/** Line height of board text, as a multiple of its font size. */
const LINE = 1.15;
/** Width of an average bold character, as a multiple of the font size (slightly generous, so lines never wrap). */
const CHAR = 0.64;
const PAD = 1;

/**
 * Board text is part of a drawing, not of the app's reading text: it is sized
 * from the board's geometry only. The phone's font-size setting and Android's
 * extra font padding must not change it.
 */
const BOARD_TEXT = { allowFontScaling: false, ellipsizeMode: 'clip', numberOfLines: 1 } as const;
const NO_PAD: TextStyle = { includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center' };

/** Font at which every one of `lines` fits a box `width` wide. */
function fontForWidth(lines: string[], width: number): number {
  return width / (Math.max(...lines.map((l) => l.length)) * CHAR);
}

/**
 * The lines a square's name is drawn on — decided here, never by the platform's
 * text wrapping. Two-word names take a line per word. A long single word
 * ("Ootacamund") is hyphenated over two lines only when that is what keeps it
 * at a readable size in a `width`-wide cell.
 */
export function nameLines(name: string, width: number, base: number): string[] {
  const words = name.trim().split(/\s+/);
  if (words.length > 1) {
    const half = Math.ceil(words.length / 2);
    return [words.slice(0, half).join(' '), words.slice(half).join(' ')];
  }
  if (name.length < 7 || fontForWidth(words, width) >= base * 0.9) return words;
  const cut = Math.ceil(name.length / 2);
  return [`${name.slice(0, cut)}-`, name.slice(cut)];
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
      <Text {...BOARD_TEXT} style={[NO_PAD, { fontSize: box * 0.68 }]}>
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

interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * What a square says, in a box of exactly `box` size: [icon] name [price], every
 * row a fixed height computed here. Priority when the box is small: name, then
 * price, then the decorative icon (dropped first).
 */
function SquareContent({ space, box, metrics, icon }: { space: BoardSpaceViewModel; box: ContentBox; metrics: SquareMetrics; icon?: string }) {
  const width = Math.max(1, box.width - 2 * PAD);
  const base = space.isCorner ? metrics.nameFont * 1.1 : metrics.nameFont;
  const lines = nameLines(space.name, width, base);
  const price = space.purchasePrice !== null ? formatINR(space.purchasePrice) : null;
  const priceFont = price ? Math.max(MIN_FONT, Math.min(metrics.priceFont, width / (price.length * 0.6))) : 0;
  const priceRow = priceFont * LINE;
  const widthFont = Math.min(base, fontForWidth(lines, width));
  const fontWith = (iconBox: number) => Math.min(widthFont, (box.height - 2 * PAD - priceRow - iconBox) / (lines.length * LINE));
  let iconBox = icon ? Math.min(box.height * (space.isCorner ? 0.44 : 0.36), width) : 0;
  // Readability first: the icon is decoration, and is dropped rather than squeezing the name.
  if (iconBox && fontWith(iconBox) < widthFont * 0.85) iconBox = 0;
  const font = Math.max(MIN_FONT, fontWith(iconBox));

  return (
    <View
      testID={`board-content-${space.index}`}
      style={{ position: 'absolute', ...box, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', opacity: space.mortgaged ? 0.45 : 1 }}
    >
      {iconBox ? <Glyph box={iconBox}>{icon!}</Glyph> : null}
      {lines.map((line, i) => (
        <Line key={i} width={width} font={font} style={{ fontWeight: '800', color: COLORS.ink }}>
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

/**
 * The colour band on a property's inner edge, with its markers. Buildings are
 * drawn as shapes (like the wooden pieces), sized so four houses plus the
 * mortgage mark always fit the band's length.
 */
function ColourBand({ space, slot, band }: { space: BoardSpaceViewModel; slot: SquareSlot; band: number }) {
  const theme = PROPERTY_GROUP_THEME[space.propertyGroup!];
  const place: ViewStyle = { left: 0, top: BAND_EDGE[slot.side] === 'top' ? 0 : slot.height - band, width: slot.width, height: band };
  const gap = 1;
  const length = slot.width;
  const piece = Math.max(2, Math.min(band * 0.7, (length - 4 - 5 * gap) / 5));
  const house: ViewStyle = { width: piece, height: piece, borderRadius: 1, backgroundColor: '#2E9E4F', borderWidth: 0.5, borderColor: '#FFFFFF' };
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
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap,
        overflow: 'hidden',
      }}
    >
      {space.hotel ? (
        <View testID={`board-hotel-${space.propertyKey}`} style={[house, { width: piece * 1.8, backgroundColor: '#D03A2B' }]} />
      ) : null}
      {Array.from({ length: space.houses }, (_, i) => (
        <View key={i} testID={`board-house-${space.propertyKey}`} style={house} />
      ))}
      {space.mortgaged ? (
        <View
          testID={`board-mortgage-${space.propertyKey}`}
          style={{ width: piece, height: piece, borderRadius: piece / 2, backgroundColor: COLORS.ink, borderWidth: 0.5, borderColor: '#FFFFFF' }}
        />
      ) : null}
    </View>
  );
}

/** Who owns it: a thin strip in the owner's player colour on the cell's outer edge. */
function OwnerStrip({ space, slot, thickness }: { space: BoardSpaceViewModel; slot: SquareSlot; thickness: number }) {
  if (!space.owner) return null;
  const place: ViewStyle =
    slot.side === 'bottom'
      ? { left: 0, top: slot.height - thickness, width: slot.width, height: thickness }
      : slot.side === 'top'
        ? { left: 0, top: 0, width: slot.width, height: thickness }
        : slot.side === 'left'
          ? { left: 0, top: 0, width: thickness, height: slot.height }
          : { left: slot.width - thickness, top: 0, width: thickness, height: slot.height };
  return <View testID={`board-owner-strip-${space.propertyKey}`} style={{ position: 'absolute', ...place, backgroundColor: playerColor(space.owner).color }} />;
}

interface SquareProps {
  space: BoardSpaceViewModel;
  slot: SquareSlot;
  metrics: SquareMetrics;
  onPress?: (index: number) => void;
}

/** Start / Jail / Club / Rest House: icon over name, in exactly one cell. */
function CornerBoardSquare({ space, slot, metrics, onPress }: SquareProps) {
  return (
    <Cell space={space} onPress={onPress} style={cellStyle(slot, COLORS.boardCorner)}>
      <SquareContent space={space} metrics={metrics} icon={SPECIAL_ICONS[space.specialType!]} box={{ left: 0, top: 0, width: slot.width, height: slot.height }} />
    </Cell>
  );
}

/** A property: colour band, owner strip on the board's outer edge, name + price in what is left. */
function PropertyBoardSquare({ space, slot, metrics, onPress }: SquareProps) {
  const theme = PROPERTY_GROUP_THEME[space.propertyGroup!];
  const { band, ownerStrip } = metrics;
  // The band and the (always reserved) owner strip take a fixed slice; the text gets exactly the rest.
  const box: ContentBox =
    slot.side === 'bottom'
      ? { left: 0, top: band, width: slot.width, height: slot.height - band - ownerStrip }
      : slot.side === 'top'
        ? { left: 0, top: ownerStrip, width: slot.width, height: slot.height - band - ownerStrip }
        : slot.side === 'left'
          ? { left: ownerStrip, top: band, width: slot.width - ownerStrip, height: slot.height - band }
          : { left: 0, top: band, width: slot.width - ownerStrip, height: slot.height - band };
  return (
    <Cell space={space} onPress={onPress} style={cellStyle(slot, theme.tint)}>
      <ColourBand space={space} slot={slot} band={band} />
      <SquareContent space={space} metrics={metrics} box={box} />
      <OwnerStrip space={space} slot={slot} thickness={ownerStrip} />
    </Cell>
  );
}

/** Chance, Community Chest and the tax squares: icon (when it fits) over name. */
function SpecialBoardSquare({ space, slot, metrics, onPress }: SquareProps) {
  return (
    <Cell space={space} onPress={onPress} style={cellStyle(slot, COLORS.board)}>
      <SquareContent space={space} metrics={metrics} icon={SPECIAL_ICONS[space.specialType!]} box={{ left: 0, top: 0, width: slot.width, height: slot.height }} />
    </Cell>
  );
}

/**
 * One square of the physical board: exactly one cell of the board layout.
 * Purely visual — no state beyond press feedback; an optional read-only
 * `onPress` for opening details. Nothing in here is rotated and nothing is
 * sized by its content.
 * Property group colour = what the property is (tint + inner colour band);
 * player colour = who owns it (thin outer strip).
 */
export const BoardSquare = memo(function BoardSquare(props: SquareProps) {
  if (props.space.isCorner) return <CornerBoardSquare {...props} />;
  return props.space.propertyKey ? <PropertyBoardSquare {...props} /> : <SpecialBoardSquare {...props} />;
});
