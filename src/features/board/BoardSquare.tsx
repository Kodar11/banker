import { memo } from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import type { PropertyKey, SpecialSpaceType } from '@/engine/index.ts';
import { COLORS, PROPERTY_GROUP_THEME, playerColor, playerInitial } from '@/constants/theme';
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
 * One square of the physical board. Purely visual: no handlers, no state.
 * Property group colour = what the property is (tint + inner colour band);
 * player colour = who owns it (thin outer strip + initial badge).
 */
export const BoardSquare = memo(function BoardSquare({ space, slot, metrics }: { space: BoardSpaceViewModel; slot: SquareSlot; metrics: SquareMetrics }) {
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
      <View
        style={[frame, { backgroundColor: COLORS.boardCorner, alignItems: 'center', justifyContent: 'center', padding: 2 }]}
        testID={`board-square-${space.index}`}
        accessible
        accessibilityLabel={describe(space)}
      >
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
      </View>
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
  // Two-line names must also leave room (across the square) for the icon / price / owner chip.
  const below = space.purchasePrice !== null ? metrics.priceFont * 1.7 : icon ? metrics.nameFont * 1.8 : 0;
  const lines = space.name.includes(' ') ? 2 : 1;
  const nameFont = Math.min(fitFont(space.name, length - 2 * pad, metrics.nameFont), (thickness - 2 - below) / (lines * 1.25));

  return (
    <View
      style={[frame, { backgroundColor: theme?.tint ?? COLORS.board }]}
      testID={`board-square-${space.index}`}
      accessible
      accessibilityLabel={describe(space)}
    >
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
        {space.owner && ownerColor ? (
          // Owned: the owner's initial chip stands where the price was (a price = still on the market).
          <View
            testID={`board-owner-${space.propertyKey}`}
            style={{
              marginTop: 1,
              minWidth: metrics.priceFont * 1.6,
              height: metrics.priceFont * 1.6,
              borderRadius: metrics.priceFont,
              paddingHorizontal: 2,
              backgroundColor: ownerColor.color,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: ownerColor.onColor, fontSize: metrics.priceFont * 1.05, fontWeight: '900', lineHeight: metrics.priceFont * 1.3 }}>
              {playerInitial(space.owner.name)}
            </Text>
          </View>
        ) : space.purchasePrice !== null ? (
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
    </View>
  );
});
