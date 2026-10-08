import { memo, type ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { PropertyKey, SpecialSpaceType } from '@/engine/index.ts';
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

const TRANSPORT_ICONS: Partial<Record<PropertyKey, string>> = {
  RAILWAY: '🚆',
  AIR_INDIA: '✈️',
  MOTOR_BOAT: '🚤',
  BEST: '🚌',
  ELECTRIC_COMPANY: '💡',
  WATER_WORKS: '🚰',
};

export interface SquareMetrics {
  band: number;
  nameFont: number;
  priceFont: number;
  ownerStrip: number;
}

/** The edge of a square that faces the board centre (where the colour band sits). */
const INNER: Record<BoardSide, 'top' | 'bottom' | 'left' | 'right'> = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' };
const OUTER: Record<BoardSide, 'top' | 'bottom' | 'left' | 'right'> = { bottom: 'bottom', top: 'top', left: 'left', right: 'right' };

/** The band's edge that faces the square's content. */
const BAND_HAIRLINE = {
  bottom: 'borderBottomWidth',
  top: 'borderTopWidth',
  left: 'borderLeftWidth',
  right: 'borderRightWidth',
} as const satisfies Record<BoardSide, keyof ViewStyle>;

function edgeStyle(edge: 'top' | 'bottom' | 'left' | 'right', thickness: number): ViewStyle {
  const base: ViewStyle = { position: 'absolute' };
  if (edge === 'top') return { ...base, top: 0, left: 0, right: 0, height: thickness };
  if (edge === 'bottom') return { ...base, bottom: 0, left: 0, right: 0, height: thickness };
  if (edge === 'left') return { ...base, top: 0, bottom: 0, left: 0, width: thickness };
  return { ...base, top: 0, bottom: 0, right: 0, width: thickness };
}

/**
 * Largest font (≤ base) at which every word of `text` fits on one line of `width`
 * — names wrap between words, never inside one ("Ootacamund", "Electric Company").
 */
export function fitFont(text: string, width: number, base: number): number {
  const longest = Math.max(...text.split(/\s+/).map((w) => w.length));
  return Math.max(5, Math.min(base, width / (longest * 0.66)));
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

/**
 * The square's frame. With `onPress` it becomes tappable — READ-ONLY: a tap only
 * opens information, it never sends a game action — but it looks exactly the same
 * (a board, not a grid of buttons); only a faint press feedback.
 */
function SquareFrame({ space, style, onPress, children }: { space: BoardSpaceViewModel; style: StyleProp<ViewStyle>; onPress?: (index: number) => void; children: ReactNode }) {
  const label = describe(space);
  if (!onPress) {
    return (
      <View style={style} testID={`board-square-${space.index}`} accessible accessibilityLabel={label}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      style={({ pressed }) => [style, pressed ? { opacity: 0.7 } : null]}
      testID={`board-square-${space.index}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Shows details"
      onPress={() => onPress(space.index)}
    >
      {children}
    </Pressable>
  );
}

/**
 * One square of the physical board. Purely visual: no state; an optional
 * read-only `onPress` for opening details.
 * Property group colour = what the property is (tint + inner colour band);
 * player colour = who owns it (thin outer strip).
 */
export const BoardSquare = memo(function BoardSquare({
  space,
  slot,
  metrics,
  onPress,
}: {
  space: BoardSpaceViewModel;
  slot: SquareSlot;
  metrics: SquareMetrics;
  onPress?: (index: number) => void;
}) {
  const frame: ViewStyle = {
    position: 'absolute',
    left: slot.x,
    top: slot.y,
    width: slot.width,
    height: slot.height,
    borderWidth: 0.5,
    borderColor: COLORS.boardLine,
    overflow: 'hidden',
  };

  if (space.isCorner) {
    return (
      <SquareFrame space={space} onPress={onPress} style={[frame, { backgroundColor: COLORS.boardCorner, alignItems: 'center', justifyContent: 'center', padding: 2 }]}>
        <Text style={{ fontSize: metrics.nameFont * 2 }} accessible={false}>
          {SPECIAL_ICONS[space.specialType!]}
        </Text>
        <Text
          style={{ fontSize: metrics.nameFont * 1.15, fontWeight: '800', color: COLORS.ink, textAlign: 'center', letterSpacing: 0.3 }}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {space.name}
        </Text>
      </SquareFrame>
    );
  }

  const theme = space.propertyGroup ? PROPERTY_GROUP_THEME[space.propertyGroup] : null;
  const horizontal = slot.side === 'left' || slot.side === 'right';
  // Content box laid out as a landscape strip, rotated on the top/bottom rows so long names
  // ("Electric Company", "Ootacamund") run along the square's depth instead of its narrow width.
  const band = theme ? metrics.band : 0;
  const length = (horizontal ? slot.width : slot.height) - band;
  const thickness = horizontal ? slot.height : slot.width;
  const contentStyle: ViewStyle = horizontal
    ? { position: 'absolute', top: 0, width: length, height: thickness, [INNER[slot.side]]: band }
    : {
        position: 'absolute',
        width: length,
        height: thickness,
        left: (thickness - length) / 2,
        top: (slot.side === 'bottom' ? band : 0) + (length - thickness) / 2,
        transform: [{ rotate: '-90deg' }],
      };
  const ownerColor = space.owner ? playerColor(space.owner) : null;
  const icon = space.specialType ? SPECIAL_ICONS[space.specialType] : undefined;
  const transportIcon = space.propertyKey ? TRANSPORT_ICONS[space.propertyKey] : undefined;
  const bandFont = band * 0.72;
  const pad = 1.5;
  // Two-line names must also leave room (across the square) for the icon / price.
  const below = space.purchasePrice !== null ? metrics.priceFont * 1.7 : icon ? metrics.nameFont * 1.8 : 0;
  const lines = space.name.includes(' ') ? 2 : 1;
  const nameFont = Math.min(fitFont(space.name, length - 2 * pad, metrics.nameFont), (thickness - 2 - below) / (lines * 1.25));

  return (
    <SquareFrame space={space} onPress={onPress} style={[frame, { backgroundColor: theme?.tint ?? COLORS.board }]}>
      {theme ? (
        <View
          testID={`board-band-${space.propertyKey}`}
          style={[
            edgeStyle(INNER[slot.side], band),
            {
              backgroundColor: theme.color,
              // The cream transport/utility band needs a hairline to read as a band.
              borderColor: theme.mark,
              [BAND_HAIRLINE[slot.side]]: space.propertyGroup === 'TRANSPORT_UTILITY' ? 0.75 : 0,
              flexDirection: horizontal ? 'column' : 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
            },
          ]}
        >
          {transportIcon ? <Text style={{ fontSize: bandFont * 0.9, lineHeight: band }}>{transportIcon}</Text> : null}
          {space.hotel ? (
            <Text testID={`board-hotel-${space.propertyKey}`} style={{ fontSize: bandFont, lineHeight: band }}>
              🏨
            </Text>
          ) : null}
          {Array.from({ length: space.houses }, (_, i) => (
            <Text key={i} testID={`board-house-${space.propertyKey}`} style={{ fontSize: bandFont * 0.92, lineHeight: band }}>
              🏠
            </Text>
          ))}
          {space.mortgaged ? (
            <View testID={`board-mortgage-${space.propertyKey}`} style={{ backgroundColor: COLORS.ink, borderRadius: 2, paddingHorizontal: 1.5 }}>
              <Text style={{ color: '#FFFFFF', fontSize: bandFont * 0.85, fontWeight: '900', lineHeight: bandFont * 1.1 }}>M</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={[contentStyle, { alignItems: 'center', justifyContent: 'center', paddingHorizontal: pad, opacity: space.mortgaged ? 0.45 : 1 }]}>
        {icon ? (
          <Text style={{ fontSize: metrics.nameFont * (space.specialType ? 1.5 : 1.15), lineHeight: metrics.nameFont * (space.specialType ? 1.8 : 1.4) }}>{icon}</Text>
        ) : null}
        <Text
          style={{ fontSize: nameFont, lineHeight: nameFont * 1.25, fontWeight: '800', color: COLORS.ink, textAlign: 'center' }}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          {space.name}
        </Text>
        {space.purchasePrice !== null ? (
          <Text
            testID={`board-price-${space.propertyKey}`}
            style={{ fontSize: Math.min(metrics.priceFont, (length - 2 * pad) / 4.6), color: '#5B5347', fontWeight: '600', marginTop: 1 }}
            numberOfLines={1}
          >
            {formatINR(space.purchasePrice)}
          </Text>
        ) : null}
      </View>

      {ownerColor ? <View testID={`board-owner-strip-${space.propertyKey}`} style={[edgeStyle(OUTER[slot.side], metrics.ownerStrip), { backgroundColor: ownerColor.color }]} /> : null}
    </SquareFrame>
  );
});
